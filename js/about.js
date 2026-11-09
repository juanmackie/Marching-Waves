"use strict";
(function(){
  var C=document.getElementById("bg");
  if(!C) return;
  var x=C.getContext("2d");
  if(!x) return;
  var W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,2);
  function size(){W=window.innerWidth;H=window.innerHeight;C.width=W*DPR;C.height=H*DPR;C.style.width=W+"px";C.style.height=H+"px";}
  window.addEventListener("resize",size); size();

  function isDark(){return window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;}
  var darkMq=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;
  if(darkMq&&darkMq.addEventListener) darkMq.addEventListener("change",function(){applyTheme();});

  var TAU=Math.PI*2, N=1800, BINS=42;
  function rnd(a,b){return a+Math.random()*(b-a);}
  function ri(a,b){return Math.round(rnd(a,b));}

  function norm(p){
    var mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
    for(var i=0;i<N;i++){var a=p[i*2],b=p[i*2+1];if(a<mnx)mnx=a;if(b<mny)mny=b;if(a>mxx)mxx=a;if(b>mxy)mxy=b;}
    var half=Math.max(mxx-mnx,mxy-mny)/2||1,cx=(mnx+mxx)/2,cy=(mny+mxy)/2;
    for(var j=0;j<N;j++){p[j*2]=(p[j*2]-cx)/half;p[j*2+1]=(p[j*2+1]-cy)/half;}
    return p;
  }
  var gens={
    liss:function(o){var p=new Float32Array(N*2);for(var i=0;i<N;i++){var t=i/N*TAU;p[i*2]=Math.sin(o.a*t+o.d);p[i*2+1]=Math.sin(o.b*t);}return p;},
    rose:function(o){var p=new Float32Array(N*2);for(var i=0;i<N;i++){var th=i/N*TAU*o.loops,r=Math.cos(o.k*th);p[i*2]=r*Math.cos(th);p[i*2+1]=r*Math.sin(th);}return p;},
    spiro:function(o){var p=new Float32Array(N*2),R=o.R,r=o.r,d=o.dd,df=R-r;for(var i=0;i<N;i++){var t=i/N*TAU*o.loops;p[i*2]=df*Math.cos(t)+d*Math.cos(df/r*t);p[i*2+1]=df*Math.sin(t)-d*Math.sin(df/r*t);}return p;}
  };
  var SEQ=["liss","rose","spiro"]; var seqi=0;
  function makeTarget(){
    var kind=SEQ[(seqi++)%SEQ.length]; var o;
    if(kind==="liss")o={a:ri(2,5),b:ri(2,5),d:rnd(0,Math.PI)};
    else if(kind==="rose")o={k:ri(3,8),loops:ri(1,4)};
    else o={R:ri(60,100),r:ri(20,55),dd:ri(40,90),loops:ri(8,22)};
    return norm(gens[kind](o));
  }

  var LIGHT_BG="#fafaf9", DARK_BG="#0c0a09";
  var PALS=[
    ["#347bb3","#7fb0d6","#1c1917"],
    ["#347bb3","#b8d4e8","#44403c"],
    ["#1c1917","#347bb3","#a8a29e"],
    ["#347bb3","#57534e","#d6d3d1"]
  ];
  var PALS_DARK=[
    ["#347bb3","#7fb0d6","#e7e5e4"],
    ["#347bb3","#5a9fd1","#a8a29e"],
    ["#e7e5e4","#347bb3","#78716c"],
    ["#347bb3","#57534e","#fafaf9"]
  ];
  function activePals(){return isDark()?PALS_DARK:PALS;}
  function h2r(h){h=h.replace("#","");return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
  function samp(pal,t){t=t<0?0:t>1?1:t;var s=(pal.length-1)*t,i=s|0,f=s-i,a=pal[i],b=pal[Math.min(i+1,pal.length-1)];return[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f];}

  var cur=makeTarget(), tgt=Float32Array.from(cur);
  var palI=0, curPal=activePals()[0].map(h2r), tgtPal=curPal.map(function(c){return c.slice();});
  function applyTheme(){var p=activePals();tgtPal=p[palI%p.length].map(h2r);}
  var rot=0, frame=0;
  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SWITCH=380;

  function draw(){
    x.setTransform(DPR,0,0,DPR,0,0);
    x.fillStyle=isDark()?DARK_BG:LIGHT_BG; x.fillRect(0,0,W,H);
    var fit=Math.min(W,H)*0.44, cx=W*0.62, cy=H*0.45;
    var cs=Math.cos(rot), sn=Math.sin(rot);
    var sx=new Float32Array(N), sy=new Float32Array(N);
    for(var i=0;i<N;i++){var ax=cur[i*2]*fit, ay=cur[i*2+1]*fit; sx[i]=cx+ax*cs-ay*sn; sy[i]=cy+ax*sn+ay*cs;}
    var bins=new Array(BINS); for(var b=0;b<BINS;b++)bins[b]=new Path2D();
    for(var j=1;j<N;j++){var bi=((j/N)*BINS)|0;if(bi>=BINS)bi=BINS-1;bins[bi].moveTo(sx[j-1],sy[j-1]);bins[bi].lineTo(sx[j],sy[j]);}
    x.lineCap="round"; x.lineJoin="round"; x.lineWidth=2.2; x.globalAlpha=isDark()?0.55:0.45;
    for(var k=0;k<BINS;k++){var c=samp(curPal,(k+0.5)/BINS),col="rgb("+(c[0]|0)+","+(c[1]|0)+","+(c[2]|0)+")";x.strokeStyle=col;x.stroke(bins[k]);}
    x.globalAlpha=1;
  }
  function tick(){
    frame++;
    if(frame%SWITCH===0){var p=activePals();tgt=makeTarget();palI=(palI+1)%p.length;tgtPal=p[palI].map(h2r);}
    var k=0.045;
    for(var i=0;i<N*2;i++)cur[i]+=(tgt[i]-cur[i])*k;
    for(var pi=0;pi<curPal.length;pi++)for(var c=0;c<3;c++)curPal[pi][c]+=(tgtPal[pi][c]-curPal[pi][c])*k;
    rot+=0.0011;
    draw();
    requestAnimationFrame(tick);
  }
  if(reduce){draw();} else {requestAnimationFrame(tick);}
})();
