const FC=require('./core.js');
function sim(mode,text,tick,fps,exposureFrac=0.6,seed=1){
  const runs=mode==='morse'?FC.encodeMorse(text):FC.encodeBinary(text);
  const ev=[];let t=500;for(const r of runs){ev.push({t,on:r.on});t+=r.units*tick;}ev.push({t,on:false});const end=t;
  const light=(x)=>{let s=false;for(const e of ev){if(e.t<=x)s=e.on;else break;}return s};
  let got=null;
  const rx=new FC.Receiver(()=>({mode,unit:tick,gate:20}),{onMessage:(r)=>{got=r}});
  const dt=1000/fps, E=dt*exposureFrac; let rnd=seed;
  const rand=()=>{rnd=(rnd*16807)%2147483647;return rnd/2147483647};
  const jitter=1;
  for(let k=0;k*dt<end+1500;k++){
    const tt=k*dt+ (rand()-0.5)*jitter; // timestamp jitter
    // integrate light over exposure
    let on=0,n=20;for(let i=0;i<n;i++) if(light(k*dt-E*i/n)) on++;
    const L=30+150*on/n+(rand()-0.5)*6;
    rx.sample(tt,L);
  }
  return got;
}
for(const [mode,tick,fps] of [['morse',100,30],['morse',70,30],['morse',50,30],['morse',40,30],['morse',60,60],['morse',30,60],['morse',20,60],['morse',10,120],['morse',8,240],['bin',80,30],['bin',50,30],['bin',40,30],['bin',25,60],['bin',20,60],['bin',10,120],['bin',5,240]]){
  const m=mode==='bin'?'binary':'morse';
  let ok=0;const N=10;
  for(let s=1;s<=N;s++){const r=sim(m,'Hello World 123',tick,fps,0.6,s*977); if(r&&r.ok&&r.text.toUpperCase()==='HELLO WORLD 123') ok++;}
  console.log(m,tick+'ms',fps+'fps',ok+'/'+N);
}
