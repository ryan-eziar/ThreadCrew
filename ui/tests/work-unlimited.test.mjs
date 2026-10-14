import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
const extract=name=>{const start=app.search(new RegExp(`^  function ${name}\\(`,'m'));assert.ok(start>=0);return app.slice(start,app.indexOf('\n  }',start)+4);};
const preset=app.slice(app.indexOf('  const PRESETS = '),app.indexOf(';',app.indexOf('  const PRESETS = '))+1);
const c={t:(text,...args)=>text.replace(/\{(\d+)\}/g,(_,i)=>String(args[i])),serverNow:()=>0,h:(tag,attrs,...children)=>({tag,attrs,children})};
vm.createContext(c);vm.runInContext([preset,...['workSettings','timeLeft','budgetMeter','timeMeter','meter','addTimeHint'].map(extract)].join('\n'),c);
test('unlimited kickoff submits explicit null limits while a regular preset retains its duration',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(c.workSettings('unlimited',10))),{unlimited:true,requestLimit:null,wakeLimit:null,durationSeconds:null});
  assert.deepEqual(JSON.parse(JSON.stringify(c.workSettings('standard',4))),{requestLimit:24,wakeLimit:48,durationSeconds:14400});
});
test('unlimited time and budget displays contain infinity and never render invalid dates or low-budget warnings',()=>{
  const w={unlimited:true,expiresAt:null,timeBudget:{unlimited:true},requestBudget:{limit:null,remaining:null,used:51},wakeBudget:{limit:null,remaining:null,used:93}};
  assert.equal(c.timeLeft(null),'不限时长');assert.equal(c.addTimeHint(w),null);
  for(const node of [c.budgetMeter(w,'requests'),c.budgetMeter(w,'wakes'),c.timeMeter(w),c.meter('Requests',null,null)]){
    const rendered=JSON.stringify(node);assert.ok(rendered.includes('∞'));assert.ok(!/NaN|tone-bad|is-low|wm-add/.test(rendered));
  }
});
