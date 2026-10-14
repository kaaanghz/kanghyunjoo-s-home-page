import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#patches");
const retry = document.querySelector("#retry");
const status = document.querySelector("#status");
const ctx = canvas.getContext("2d", { alpha: true });

function trackEvent(name, parameters = {}) {
  if (typeof window.gtag === "function") {
    window.gtag("event", name, { example_id: "track_to_move", ...parameters });
  }
}

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MIN_PATCHES = 4;
const MAX_PATCHES = 12;
const DETECT_INTERVAL = 90;
const MOTION_WIDTH = 96;
const MOTION_HEIGHT = 54;
const motionCanvas = document.createElement("canvas");
motionCanvas.width = MOTION_WIDTH;
motionCanvas.height = MOTION_HEIGHT;
const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });

let landmarker;
let pose = null;
let patches = [];
let lastDetection = 0;
let lastVideoTime = -1;
let nextPatchAt = 0;
let viewWidth = 0;
let viewHeight = 0;
let stream;
let cameraStartedAt = 0;
let poseErrorReported = false;
let previousFrame = null;
let motionPoints = [];

const random = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  canvas.width = Math.round(viewWidth * ratio);
  canvas.height = Math.round(viewHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

// Coordinates use the same "cover" crop as the unfiltered video element.
function videoLayout() {
  const scale = Math.max(viewWidth / video.videoWidth, viewHeight / video.videoHeight);
  return {
    scale,
    left: (viewWidth - video.videoWidth * scale) / 2,
    top: (viewHeight - video.videoHeight * scale) / 2,
  };
}

function detectMotion() {
  motionCtx.drawImage(video, 0, 0, MOTION_WIDTH, MOTION_HEIGHT);
  const current = motionCtx.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT).data;
  const moving = [];
  if (previousFrame) {
    const changed = new Uint8Array(MOTION_WIDTH * MOTION_HEIGHT);
    for (let y = 1; y < MOTION_HEIGHT - 1; y++) {
      for (let x = 1; x < MOTION_WIDTH - 1; x++) {
        const index = (y * MOTION_WIDTH + x) * 4;
        const difference = (
          Math.abs(current[index] - previousFrame[index]) +
          Math.abs(current[index + 1] - previousFrame[index + 1]) +
          Math.abs(current[index + 2] - previousFrame[index + 2])
        ) / 3;
        if (difference > 32) changed[y * MOTION_WIDTH + x] = 1;
      }
    }
    for (let y = 2; y < MOTION_HEIGHT - 2; y++) {
      for (let x = 2; x < MOTION_WIDTH - 2; x++) {
        const index = y * MOTION_WIDTH + x;
        if (!changed[index]) continue;
        const neighbors = changed[index - 1] + changed[index + 1] +
          changed[index - MOTION_WIDTH] + changed[index + MOTION_WIDTH];
        if (neighbors >= 2) moving.push({ x: (x + 0.5) / MOTION_WIDTH, y: (y + 0.5) / MOTION_HEIGHT });
      }
    }
  }
  previousFrame = new Uint8ClampedArray(current);
  motionPoints = moving.length >= 8 ? moving : [];
}

function movingPoint() {
  if (!motionPoints.length) return null;
  // Prefer motion close to detected pose landmarks when a person is present.
  if (pose) {
    for (let i = 0; i < 12; i++) {
      const point = motionPoints[Math.floor(random(0, motionPoints.length))];
      const nearBody = pose.some((landmark) =>
        (landmark.visibility ?? 1) > 0.45 &&
        Math.hypot((landmark.x - point.x) * video.videoWidth, (landmark.y - point.y) * video.videoHeight) < video.videoWidth * 0.16
      );
      if (nearBody) return point;
    }
  }
  return motionPoints[Math.floor(random(0, motionPoints.length))];
}

function makePatch(now) {
  const { scale, left, top } = videoLayout();
  for (let attempt = 0; attempt < 18; attempt++) {
    const point = movingPoint();
    if (!point) return false;

    const centerX = viewWidth - (left + point.x * video.videoWidth * scale);
    const centerY = top + point.y * video.videoHeight * scale;
    if (centerX < 0 || centerX > viewWidth || centerY < 0 || centerY > viewHeight) continue;

    const base = Math.min(viewWidth, viewHeight);
    const width = clamp(base * random(0.025, 0.25), 12, 180);
    const height = clamp(width * random(0.25, 1.5), 8, 145);
    const x = clamp(centerX - width / 2, 0, viewWidth - width);
    const y = clamp(centerY - height / 2, 0, viewHeight - height);
    const crowded = patches.some((patch) => {
      const overlapWidth = Math.max(0, Math.min(x + width, patch.x + patch.width) - Math.max(x, patch.x));
      const overlapHeight = Math.max(0, Math.min(y + height, patch.y + patch.height) - Math.max(y, patch.y));
      return overlapWidth * overlapHeight > width * height * 0.35;
    });
    if (crowded) continue;

    patches.push({
      x, y, width, height,
      anchorX: x + (Math.random() < 0.5 ? 0 : width),
      anchorY: y + (Math.random() < 0.5 ? 0 : height),
      expires: now + random(133, 533),
    });
    return true;
  }
  return false;
}

function drawConnections() {
  if (patches.length < 2) return;

  const connected = new Set();
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.68)";
  ctx.lineWidth = 0.7;
  const drawLine = (fromIndex, toIndex) => {
    const key = `${Math.min(fromIndex, toIndex)}-${Math.max(fromIndex, toIndex)}`;
    if (connected.has(key)) return;
    connected.add(key);
    const from = patches[fromIndex];
    const to = patches[toIndex];
    ctx.beginPath();
    ctx.moveTo(from.anchorX, from.anchorY);
    ctx.lineTo(to.anchorX, to.anchorY);
    ctx.stroke();
  };

  // First connect every patch into one network using the shortest available links.
  const joined = new Set([0]);
  while (joined.size < patches.length) {
    let shortest = { from: -1, to: -1, distance: Infinity };
    for (const from of joined) {
      for (let to = 0; to < patches.length; to++) {
        if (joined.has(to)) continue;
        const distance = Math.hypot(
          patches[from].anchorX - patches[to].anchorX,
          patches[from].anchorY - patches[to].anchorY
        );
        if (distance < shortest.distance) shortest = { from, to, distance };
      }
    }
    drawLine(shortest.from, shortest.to);
    joined.add(shortest.to);
  }

  // Add a few cross-links like the reference video.
  for (let i = 0; i < patches.length; i++) {
    const from = patches[i];
    const neighbors = patches
      .map((patch, index) => ({
        index,
        distance: Math.hypot(from.anchorX - patch.anchorX, from.anchorY - patch.anchorY),
      }))
      .filter((item) => item.index !== i)
      .sort((a, b) => a.distance - b.distance);

    const linkCount = i % 3 === 0 ? 3 : 2;
    for (const { index } of neighbors.slice(0, linkCount)) {
      drawLine(i, index);
    }
  }
  ctx.restore();
}

function drawPatches() {
  ctx.clearRect(0, 0, viewWidth, viewHeight);
  if (!video.videoWidth || !video.videoHeight) return;

  drawConnections();
  const { scale, left, top } = videoLayout();
  for (const patch of patches) {
    const sx = (viewWidth - patch.x - patch.width - left) / scale;
    const sy = (patch.y - top) / scale;
    const sw = patch.width / scale;
    const sh = patch.height / scale;
    // Flip the copied pixels to match the mirrored camera underneath.
    ctx.save();
    ctx.translate(patch.x + patch.width, patch.y);
    ctx.scale(-1, 1);
    ctx.filter = "invert(1)";
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, patch.width, patch.height);
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 1;
    ctx.strokeRect(patch.x + 0.5, patch.y + 0.5, patch.width - 1, patch.height - 1);

    const position = `${Math.round(patch.x)}, ${Math.round(patch.y)}`;
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff";
    const labelX = Math.max(1, Math.min(patch.x + 1, viewWidth - ctx.measureText(position).width - 2));
    const labelY = patch.y >= 13 ? patch.y - 12 : patch.y + patch.height + 2;
    ctx.fillText(position, labelX, labelY);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!video.videoWidth) return;

  if (now - lastDetection >= DETECT_INTERVAL) {
    lastDetection = now;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      detectMotion();
      if (landmarker) {
        try {
          pose = landmarker.detectForVideo(video, now).landmarks[0] || null;
        } catch (error) {
          console.error("Pose detection failed", error);
          pose = null;
          if (!poseErrorReported) {
            trackEvent("example_error", { stage: "runtime", error_type: "pose_detection" });
            poseErrorReported = true;
          }
        }
      }
    } else {
      motionPoints = [];
    }
  }

  patches = patches.filter((patch) => patch.expires > now);
  if (motionPoints.length && now >= nextPatchAt && patches.length < MAX_PATCHES) {
    const target = Math.floor(random(8, MAX_PATCHES + 1));
    const amount = Math.min(target - patches.length, Math.max(Math.floor(random(1, 4)), MIN_PATCHES - patches.length));
    for (let i = 0; i < amount; i++) makePatch(now);
    nextPatchAt = now + random(35, 90);
  }
  drawPatches();
}

async function loadPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  try {
    return await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  } catch {
    trackEvent("example_fallback", { component: "pose_landmarker", reason: "gpu_unavailable" });
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }
}

function endCamera(reason) {
  if (cameraStartedAt) {
    trackEvent("example_end", {
      duration_seconds: Math.round((performance.now() - cameraStartedAt) / 1000),
      end_reason: reason,
    });
    cameraStartedAt = 0;
  }
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
}

async function startCamera() {
  retry.hidden = true;
  trackEvent("example_start_attempt");
  try {
    endCamera("restart");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 340, max: 340 }, height: { ideal: 190, max: 190 } },
    });
    video.srcObject = stream;
    await video.play();
    cameraStartedAt = performance.now();
    trackEvent("example_start");
    stream.getVideoTracks()[0]?.addEventListener("ended", () => endCamera("camera_ended"), { once: true });
    previousFrame = null;
    motionPoints = [];
    patches = [];
    status.textContent = "카메라가 연결되었습니다.";
  } catch (error) {
    console.error("Camera access failed", error);
    endCamera("startup_error");
    trackEvent("example_error", {
      stage: "startup",
      error_type: error instanceof Error ? error.name : "unknown",
    });
    status.textContent = "카메라에 연결할 수 없습니다. 카메라 버튼을 눌러 다시 시도하세요.";
    retry.hidden = false;
  }
}

resize();
window.addEventListener("resize", resize);
retry.addEventListener("click", startCamera);
window.addEventListener("pagehide", () => endCamera("page_exit"));
requestAnimationFrame(frame);
startCamera();
loadPoseLandmarker()
  .then((result) => { landmarker = result; })
  .catch((error) => {
    console.error("Pose Landmarker could not load", error);
    trackEvent("example_error", { stage: "startup", error_type: "pose_landmarker_load" });
    status.textContent = "포즈 감지를 불러오지 못했습니다.";
  });
