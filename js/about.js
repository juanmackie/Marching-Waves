"use strict";
(function(){
  const C=document.getElementById("bg"), x=C.getContext("2d");
  let W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,2);
  function size(){W=window.innerWidth;H=window.innerHeight;C.width=W*DPR;C.height=H*DPR;C.style.width=W+"px";C.style.height=H+"px";}
  window.addEventListener("resize",size); size();

  const TAU=Math.PI*2, N=1800, BINS=42;
  const rnd=(a,b)=>a+Math.random()*(b-a), ri=(a,b)=>Math.round(rnd(a,b));

  function norm(p){
    let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
    for(let i=0;i<N;i++){const a=p[i*2],b=p[i*2+1];if(a<mnx)mnx=a;if(b<mny)mny=b;if(a>mxx)mxx=a;if(b>mxy)mxy=b;}
    const half=Math.max(mxx-mnx,mxy-mny)/2||1,cx=(mnx+mxx)/2,cy=(mny+mxy)/2;
    for(let i=0;i<N;i++){p[i*2]=(p[i*2]-cx)/half;p[i*2+1]=(p[i*2+1]-cy)/half;}
    return p;
  }
  const gens={
    liss(o){const p=new Float32Array(N*2);for(let i=0;i<N;i++){const t=i/N*TAU;p[i*2]=Math.sin(o.a*t+o.d);p[i*2+1]=Math.sin(o.b*t);}return p;},
    rose(o){const p=new Float32Array(N*2);for(let i=0;i<N;i++){const th=i/N*TAU*o.loops,r=Math.cos(o.k*th);p[i*2]=r*Math.cos(th);p[i*2+1]=r*Math.sin(th);}return p;},
    spiro(o){const p=new Float32Array(N*2),R=o.R,r=o.r,d=o.dd,df=R-r;for(let i=0;i<N;i++){const t=i/N*TAU*o.loops;p[i*2]=df*Math.cos(t)+d*Math.cos(df/r*t);p[i*2+1]=df*Math.sin(t)-d*Math.sin(df/r*t);}return p;}
  };
  const SEQ=["liss","rose","spiro"]; let seqi=0;
  function makeTarget(){
    const kind=SEQ[(seqi++)%SEQ.length]; let o;
    if(kind==="liss")o={a:ri(2,5),b:ri(2,5),d:rnd(0,Math.PI)};
    else if(kind==="rose")o={k:ri(3,8),loops:ri(1,4)};
    else o={R:ri(60,100),r:ri(20,55),dd:ri(40,90),loops:ri(8,22)};
    return norm(gens[kind](o));
  }

  const PALS=[["#d99a5f","#f3d9b1","#77c7d9"],["#7303c0","#ec38bc","#26d0ce"],["#ff7e5f","#feb47b","#ffe98a"],["#1e88a8","#5fd0c5","#dffcf2"],["#a8602e","#d99a5f","#eaf2ff"]];
  function h2r(h){h=h.replace("#","");return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
  function samp(pal,t){t=t<0?0:t>1?1:t;const s=(pal.length-1)*t,i=s|0,f=s-i,a=pal[i],b=pal[Math.min(i+1,pal.length-1)];return[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f];}

  let cur=makeTarget(), tgt=Float32Array.from(cur);
  let palI=0, curPal=PALS[0].map(h2r), tgtPal=curPal.map(c=>c.slice());
  let rot=0, frame=0;
  const reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SWITCH=380;

  function draw(){
    x.setTransform(DPR,0,0,DPR,0,0);
    x.fillStyle="#0b0d12"; x.fillRect(0,0,W,H);
    const fit=Math.min(W,H)*0.44, cx=W*0.62, cy=H*0.45;
    const cs=Math.cos(rot), sn=Math.sin(rot);
    const sx=new Float32Array(N), sy=new Float32Array(N);
    for(let i=0;i<N;i++){const ax=cur[i*2]*fit, ay=cur[i*2+1]*fit; sx[i]=cx+ax*cs-ay*sn; sy[i]=cy+ax*sn+ay*cs;}
    const bins=new Array(BINS); for(let b=0;b<BINS;b++)bins[b]=new Path2D();
    for(let i=1;i<N;i++){let b=((i/N)*BINS)|0;if(b>=BINS)b=BINS-1;bins[b].moveTo(sx[i-1],sy[i-1]);bins[b].lineTo(sx[i],sy[i]);}
    x.lineCap="round"; x.lineJoin="round"; x.lineWidth=2.6; x.globalAlpha=0.5;
    for(let b=0;b<BINS;b++){const c=samp(curPal,(b+0.5)/BINS),col=`rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;x.strokeStyle=col;x.stroke(bins[b]);}
    x.globalAlpha=1;
  }
  function tick(){
    frame++;
    if(frame%SWITCH===0){tgt=makeTarget();palI=(palI+1)%PALS.length;tgtPal=PALS[palI].map(h2r);}
    const k=0.045;
    for(let i=0;i<N*2;i++)cur[i]+=(tgt[i]-cur[i])*k;
    for(let p=0;p<curPal.length;p++)for(let c=0;c<3;c++)curPal[p][c]+=(tgtPal[p][c]-curPal[p][c])*k;
    rot+=0.0011;
    draw();
    requestAnimationFrame(tick);
  }
  if(reduce){draw();} else {requestAnimationFrame(tick);}
})();
