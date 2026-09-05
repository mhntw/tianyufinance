// 由 26 年账套生成自洽的 25 年测试账套（不破坏原账套），放入 data/books
// 方案：25年期初清零 + 25年1~7月镜像26年1~7月凭证 + 25年8~12月派生凭证(基于1~7月均值，保持借贷平衡)
// 目的：验证软件对"拥有完整12个月+期初为0的年度账套"能正确处理(勾稽/结转/报表/结账)
const fs=require('fs'),path=require('path');
const booksDir=path.join(__dirname,'..','data','books');
const num=x=>{x=Number(x);return isNaN(x)?0:x;};
const EPS=0.005;

for(const file of fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak')&&f.indexOf('2026')>=0)){
  const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
  const name=st.company&&st.company.name||file;
  const newName=name.replace('2026年','2025年')+'_测试版';
  console.log('\n==== 生成 25年测试账套: '+newName);

  // 1) 26年1~7月各科目净发生额(按 code 汇总)，用于派生8~12月
  const net26={};
  (st.vouchers||[]).forEach(v=>{
    const m=(v.date||'').slice(0,7); if(m<'2026-01'||m>'2026-07')return;
    v.entries.forEach(e=>{
      net26[e.code]=net26[e.code]||{dr:0,cr:0};
      net26[e.code].dr+=num(e.dr); net26[e.code].cr+=num(e.cr);
    });
  });
  const subjName=code=>(st.subjects.find(s=>s.code===code)||{}).name||code;

  // 2) 凭证：镜像 2026-01~07 -> 2025-01~07
  const vouchers=[];
  (st.vouchers||[]).forEach(v=>{
    const m=(v.date||'').slice(0,7); if(m<'2026-01'||m>'2026-07')return;
    const newDate=v.date.replace('2026','2025');
    vouchers.push(Object.assign({}, v, {date:newDate, period:parseInt(newDate.slice(5,7),10), checked:v.checked||false, posted:v.posted!==false}));
  });

  // 3) 派生 2025-08~12：对 1~7 月净发生额(code级) 按 (5/7)/5 摊到每月，构造借贷平衡的汇总凭证
  ['2025-08','2025-09','2025-10','2025-11','2025-12'].forEach((m,idx)=>{
    const entries=[];
    Object.keys(net26).forEach(code=>{
      const n=net26[code]; const monthlyDr=(num(n.dr))*(5/7)/5, monthlyCr=(num(n.cr))*(5/7)/5;
      if(monthlyDr>EPS) entries.push({code, name:subjName(code), summary:m+'派生', dr:Math.round(monthlyDr*100)/100, cr:0});
      if(monthlyCr>EPS) entries.push({code, name:subjName(code), summary:m+'派生', dr:0, cr:Math.round(monthlyCr*100)/100});
    });
    if(entries.length>=2){
      let d=0,c=0; entries.forEach(e=>{d+=num(e.dr);c+=num(e.cr);});
      const diff=Math.round((d-c)*100)/100;
      if(Math.abs(diff)>=EPS){ if(diff>0) entries.push({code:'1001',name:'库存现金',summary:'派生平衡',dr:0,cr:diff}); else entries.push({code:'1001',name:'库存现金',summary:'派生平衡',dr:-diff,cr:0}); }
      vouchers.push({word:'记',no:9000+idx,date:m+'-15',period:parseInt(m.slice(5,7),10),attach:0,summary:'派生汇总',status:'audited',checked:true,posted:true,entries});
    }
  });

  // 4) 组装：期初清零
  const newSt=JSON.parse(JSON.stringify(st));
  newSt.company=Object.assign({}, st.company, {name:newName, startMonth:'2025-01'});
  newSt.openingBalances={}; // 期初为0，保证借贷平衡
  newSt.vouchers=vouchers;
  newSt.closedPeriods=[];
  newSt.currentPeriod='';

  const outFile=path.join(booksDir, file.replace('2026','2025').replace('.json','_测试版.json'));
  if(fs.existsSync(outFile)) fs.unlinkSync(outFile);
  fs.writeFileSync(outFile, JSON.stringify(newSt,null,1));
  console.log('  凭证数='+vouchers.length);
  console.log('  输出: '+path.basename(outFile));
}
