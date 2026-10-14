import { FilesetResolver, FaceLandmarker, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';

const video = document.querySelector('#webcam');
const canvas = document.querySelector('#scene');
const ctx = canvas.getContext('2d');
const startButton = document.querySelector('#startButton');
const resetButton = document.querySelector('#resetButton');
const trackingStatus = document.querySelector('#trackingStatus');
const meterFill = document.querySelector('#meterFill');
const meterText = document.querySelector('#meterText');
const prompt = document.querySelector('#prompt');
const experience = document.querySelector('.experience');

let faceLandmarker, handLandmarker, running = false, lastVideoTime = -1;
let startedAt = 0;

function trackEvent(name, parameters = {}) {
  if (typeof window.gtag === 'function') {
    window.gtag('event', name, { example_id: 'balloon_face', ...parameters });
  }
}

function endExperience(reason) {
  if (startedAt) {
    trackEvent('example_end', {
      duration_seconds: Math.round((performance.now() - startedAt) / 1000),
      end_reason: reason,
    });
    startedAt = 0;
  }
  running = false;
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}
let face = null, hands = [], blendshapes = [], faceBox = null, inflate = 0, lastTick = 0, lastRender = 0, puckerStartedAt = 0, maxInflationAt = 0;
let balloons = [], pendingCapture = false, breathLocked = false, activeBreath = false;
const sourceCanvas = document.createElement('canvas'), sourceCtx = sourceCanvas.getContext('2d');
const faceLayer = document.createElement('canvas'), faceLayerCtx = faceLayer.getContext('2d');
const featherMask = document.createElement('canvas'), featherMaskCtx = featherMask.getContext('2d');
const FACE_EDGE = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,152,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const BALLOON_COLORS = ['rgba(237,65,65,.30)', 'rgba(255,94,171,.28)', 'rgba(248,207,49,.29)', 'rgba(64,139,255,.28)', 'rgba(59,190,106,.29)'];

function resize() { const ratio = Math.min(devicePixelRatio || 1, 2); canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio; ctx.setTransform(ratio,0,0,ratio,0,0); [sourceCanvas,faceLayer,featherMask].forEach(c=>{c.width=innerWidth;c.height=innerHeight;}); }
function p(landmark) { return { x: (1-landmark.x)*innerWidth, y: landmark.y*innerHeight }; }
function getFaceBox(landmarks) { const pts = landmarks.map(p); let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity; pts.forEach(q=>{minX=Math.min(minX,q.x);minY=Math.min(minY,q.y);maxX=Math.max(maxX,q.x);maxY=Math.max(maxY,q.y);}); return {x:(minX+maxX)/2,y:(minY+maxY)/2,w:maxX-minX,h:maxY-minY}; }
function drawVideo(target = ctx) { target.save(); target.translate(innerWidth,0); target.scale(-1,1); target.drawImage(video,0,0,video.videoWidth,video.videoHeight,0,0,innerWidth,innerHeight); target.restore(); }
function facePath(target, box, scale = 1, offsetX = 0, offsetY = 0) { const points = FACE_EDGE.map(index => { const q=p(face[index]); return {x:box.x+(q.x-box.x)*scale-offsetX,y:box.y+(q.y-box.y)*scale-offsetY}; }); target.beginPath(); points.forEach((q,i)=>i?target.lineTo(q.x,q.y):target.moveTo(q.x,q.y)); target.closePath(); }
function balloonPath(target, box, radiusX, radiusY = radiusX, offsetX = 0, offsetY = 0) { target.beginPath(); target.ellipse(box.x-offsetX,box.y-offsetY,radiusX,radiusY,0,0,Math.PI*2); target.closePath(); }
function drawInflatedFace() {
  if (!face || !faceBox || inflate < .01) return;
  // A radial lens warp magnifies the centre more than the edge, like a convex mirror.
  const scale = 1 + inflate, radiusX = Math.max(faceBox.w,faceBox.h)*.52*scale, radiusY = radiusX*1.06, outW = Math.round(radiusX*2), outH = Math.round(radiusY*2);
  const left = Math.round(faceBox.x-radiusX), top = Math.round(faceBox.y-radiusY);
  const cropW = Math.max(2,Math.round(faceBox.w*1.18)), cropH = Math.max(2,Math.round(faceBox.h*1.22));
  const cropX = Math.max(0,Math.round(faceBox.x-cropW/2)), cropY = Math.max(0,Math.round(faceBox.y-cropH/2));
  const source = sourceCtx.getImageData(cropX,cropY,Math.min(cropW,innerWidth-cropX),Math.min(cropH,innerHeight-cropY));
  const patch = faceLayerCtx.createImageData(outW,outH), srcW=source.width, srcH=source.height;
  for(let y=0;y<outH;y++) for(let x=0;x<outW;x++) {
    const nx=(x-outW/2)/radiusX, ny=(y-outH/2)/radiusY, r2=Math.min(1,nx*nx+ny*ny);
    const lens=1+inflate*.96*(1-r2), sx=Math.max(0,Math.min(srcW-1,Math.round(srcW/2+nx*faceBox.w/2/lens))), sy=Math.max(0,Math.min(srcH-1,Math.round(srcH/2+ny*faceBox.h/2/lens)));
    const si=(sy*srcW+sx)*4, di=(y*outW+x)*4; patch.data[di]=source.data[si];patch.data[di+1]=source.data[si+1];patch.data[di+2]=source.data[si+2];patch.data[di+3]=255;
  }
  faceLayerCtx.clearRect(0,0,innerWidth,innerHeight); faceLayerCtx.putImageData(patch,left,top);
  // Fully opaque round form: the original camera remains untouched outside this circle.
  featherMaskCtx.clearRect(0,0,innerWidth,innerHeight); balloonPath(featherMaskCtx,faceBox,radiusX,radiusY); featherMaskCtx.fillStyle='#fff'; featherMaskCtx.fill();
  faceLayerCtx.save(); faceLayerCtx.globalCompositeOperation='destination-in'; faceLayerCtx.drawImage(featherMask,0,0); faceLayerCtx.restore();
  // These light fields are baked into the capture, so the floating face has a smooth rubber balloon skin.
  faceLayerCtx.save(); faceLayerCtx.globalCompositeOperation='source-atop';
  const gloss=faceLayerCtx.createRadialGradient(faceBox.x-radiusX*.34,faceBox.y-radiusY*.50,radiusX*.02,faceBox.x-radiusX*.15,faceBox.y-radiusY*.28,radiusY*1.13); gloss.addColorStop(0,'rgba(255,255,255,.50)');gloss.addColorStop(.18,'rgba(255,255,255,.16)');gloss.addColorStop(.52,'rgba(255,255,255,0)');gloss.addColorStop(1,'rgba(7,13,20,.27)');faceLayerCtx.fillStyle=gloss;faceLayerCtx.fillRect(left,top,outW,outH);
  const rim=faceLayerCtx.createLinearGradient(faceBox.x,top,faceBox.x,top+outH);rim.addColorStop(0,'rgba(255,255,255,.18)');rim.addColorStop(.48,'rgba(255,255,255,0)');rim.addColorStop(1,'rgba(5,10,15,.28)');faceLayerCtx.fillStyle=rim;faceLayerCtx.fillRect(left,top,outW,outH);
  faceLayerCtx.beginPath();faceLayerCtx.ellipse(faceBox.x-radiusX*.29,faceBox.y-radiusY*.54,radiusX*.15,radiusY*.045,-.67,0,Math.PI*2);faceLayerCtx.fillStyle='rgba(255,255,255,.20)';faceLayerCtx.fill();faceLayerCtx.restore();
  ctx.save();ctx.filter='blur(4px)';ctx.globalAlpha=.34;ctx.drawImage(faceLayer,0,0,innerWidth,innerHeight);ctx.restore();ctx.drawImage(faceLayer,0,0,innerWidth,innerHeight);
}
function makeBalloon() {
  const scale = 1.5, radiusX = Math.max(faceBox.w,faceBox.h)*.52*scale, radiusY = radiusX*1.06, sourceW = radiusX*2, sourceH = radiusY*2;
  const snap = document.createElement('canvas'); snap.width = Math.max(4,Math.round(sourceW)); snap.height = Math.max(4,Math.round(sourceH));
  const sctx = snap.getContext('2d'); balloonPath(sctx,faceBox,radiusX,radiusY,faceBox.x-radiusX,faceBox.y-radiusY); sctx.clip();
  // Capture only the already-warped face layer — never the unchanged camera frame behind it.
  sctx.drawImage(faceLayer, faceBox.x-sourceW/2, faceBox.y-sourceH/2, sourceW, sourceH, 0,0,snap.width,snap.height);
  const color = BALLOON_COLORS[Math.floor(Math.random()*BALLOON_COLORS.length)];
  // The color is a translucent overlay, while the balloon image itself stays fully opaque.
  sctx.fillStyle=color; sctx.fillRect(0,0,snap.width,snap.height);
  balloons.push({image:snap,x:faceBox.x-sourceW/2,y:faceBox.y-sourceH/2,w:sourceW,h:sourceH,drift:(Math.random()-.5)*18,phase:Math.random()*Math.PI*2});
  trackEvent('example_capture', { capture_number: balloons.length });
  if (balloons.length > 7) balloons.shift();
}
function drawBalloons(dt) {
  balloons = balloons.filter(b=>b.y+b.h>-90);
  balloons.forEach(b=>{ b.y -= dt*46.5; b.x += Math.sin(performance.now()/900+b.phase)*dt*5+b.drift*dt*.06; const x=b.x+b.w/2, y=b.y+b.h; ctx.save(); ctx.filter='blur(4px)';ctx.globalAlpha=.32;ctx.drawImage(b.image,b.x-2,b.y-2,b.w+4,b.h+4);ctx.restore();ctx.save(); ctx.globalAlpha=1; ctx.drawImage(b.image,b.x,b.y,b.w,b.h);
    // Tied neck and a double-strand curled string make the captured face read as a real balloon.
    ctx.beginPath();ctx.moveTo(x-5,y-3);ctx.lineTo(x+5,y-3);ctx.lineTo(x+2,y+7);ctx.lineTo(x,y+10);ctx.lineTo(x-2,y+7);ctx.closePath();ctx.fillStyle='#d7e3da';ctx.fill();ctx.strokeStyle='#68766e';ctx.lineWidth=.7;ctx.stroke();
    ctx.beginPath();ctx.moveTo(x,y+8);ctx.bezierCurveTo(x+15,y+26,x-14,y+43,x+3,y+64);ctx.bezierCurveTo(x+13,y+78,x-7,y+91,x+4,y+111);ctx.strokeStyle='#ede8dc';ctx.lineWidth=1.05;ctx.stroke();
    ctx.beginPath();ctx.moveTo(x+1,y+9);ctx.bezierCurveTo(x+16,y+26,x-13,y+43,x+4,y+64);ctx.bezierCurveTo(x+14,y+78,x-6,y+91,x+5,y+111);ctx.strokeStyle='#7c857e';ctx.lineWidth=.36;ctx.stroke();ctx.restore(); });
}
function score(name) { return blendshapes.find(c=>c.categoryName===name)?.score || 0; }
function isPuckeringWithThumb() {
  if (!face || !faceBox || !hands.length) return false;
  const upperLip=p(face[13]), lowerLip=p(face[14]), mouth={x:(upperLip.x+lowerLip.x)/2,y:(upperLip.y+lowerLip.y)/2};
  const thumbAtLips=hands.some(hand=>{const thumb=p(hand[4]);return Math.hypot((thumb.x-mouth.x)/faceBox.w,(thumb.y-mouth.y)/faceBox.h)<.25;});
  const pucker = score('mouthPucker') + score('mouthFunnel')*.72;
  return thumbAtLips && pucker > .22;
}
function updateBreath(time) {
  const dt = Math.min(.05,(time-lastTick)/1000 || 0); lastTick=time; activeBreath=isPuckeringWithThumb();
  if (maxInflationAt && !breathLocked) {
    // Once the balloon is fully formed, it stays formed even if the thumb leaves the lips.
    inflate=.5; if(time-maxInflationAt>=3000){pendingCapture=true;breathLocked=true;}
  } else if (activeBreath && !breathLocked) {
    if (!puckerStartedAt) puckerStartedAt=time;
    if(time-puckerStartedAt>=2000) inflate=Math.min(.5,inflate+dt*.38);
    if(inflate>=.498) { inflate=.5; if(!maxInflationAt)maxInflationAt=time; }
  } else if(!activeBreath) { inflate=Math.max(0,inflate-dt*.5); breathLocked=false; puckerStartedAt=0; maxInflationAt=0; }
  const waiting=activeBreath&&puckerStartedAt&&time-puckerStartedAt<2000, holding=maxInflationAt&&!breathLocked;
  meterFill.style.width=`${Math.round(inflate*200)}%`; meterText.textContent=waiting?'WAIT…':holding?'READY!':`${Math.round(inflate*100)}%`; prompt.classList.toggle('ready',activeBreath); prompt.textContent=waiting?'THUMB + PUCKER DETECTED · HOLD FOR 2 SECONDS':holding?'BALLOON FORMED · HOLD FOR 3 SECONDS':activeBreath?'KEEP PUFFING · HOLD THE AIR':'THUMB TO LIPS · PUCKER YOUR MOUTH';
}
function render(time) {
  if (!running) return; const dt=Math.min(.05,(time-lastRender)/1000 || 0); lastRender=time; sourceCtx.clearRect(0,0,innerWidth,innerHeight); drawVideo(sourceCtx); ctx.clearRect(0,0,innerWidth,innerHeight); ctx.drawImage(sourceCanvas,0,0,innerWidth,innerHeight); drawInflatedFace();
  if (pendingCapture && faceBox) { makeBalloon(); pendingCapture=false; inflate=0; }
  drawBalloons(dt); requestAnimationFrame(render);
}
async function detect() {
  if (!running) return;
  if (video.currentTime !== lastVideoTime) { lastVideoTime=video.currentTime; const now=performance.now(), f=faceLandmarker.detectForVideo(video,now), h=handLandmarker.detectForVideo(video,now); face=f.faceLandmarks?.[0]||null; hands=h.landmarks||[]; blendshapes=f.faceBlendshapes?.[0]?.categories||[]; faceBox=face?getFaceBox(face):null; trackingStatus.textContent=face?'THUMB + PUCKER READY':'SEARCHING FOR FACE'; updateBreath(now); }
  requestAnimationFrame(detect);
}
async function start() {
  trackEvent('example_start_attempt');
  startButton.hidden = true;
  startButton.disabled=true; trackingStatus.textContent='TRACKER LOADING…';
  try {
    const files=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    faceLandmarker=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',delegate:'GPU'},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:true});
    handLandmarker=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',delegate:'GPU'},runningMode:'VIDEO',numHands:2});
    video.srcObject=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},audio:false}); await video.play(); running=true; startedAt=performance.now(); trackEvent('example_start'); experience.classList.add('live'); trackingStatus.textContent='SEARCHING FOR FACE'; lastTick=performance.now(); lastRender=performance.now(); detect(); requestAnimationFrame(render);
  } catch(error) { console.error(error); endExperience('startup_error'); trackEvent('example_error', { stage: 'startup', error_type: error instanceof Error ? error.name : 'unknown' }); startButton.disabled=false; startButton.textContent='카메라 다시 시도 ↗'; startButton.hidden=false; trackingStatus.textContent='CAMERA ACCESS REQUIRED'; }
}
startButton.addEventListener('click',start); resetButton.addEventListener('click',()=>{trackEvent('example_reset');balloons=[];inflate=0;pendingCapture=false;breathLocked=false;maxInflationAt=0;}); addEventListener('resize',resize); addEventListener('pagehide',()=>endExperience('page_exit')); resize(); start();
