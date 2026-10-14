const MAX_CAPTURES = 3;
const VISION_MODULE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const GESTURE_MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const SEGMENT_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";

const video = document.querySelector("#camera");
const overlay = document.querySelector("#captures");
const overlayCtx = overlay.getContext("2d");
const startButton = document.querySelector("#startButton");
const captureButton = document.querySelector("#captureButton");
const resetButton = document.querySelector("#resetButton");
const statusText = document.querySelector("#statusText");
const progress = document.querySelector("#progress");
const progressDots = [...progress.querySelectorAll("span")];
const flash = document.querySelector("#flash");
const countdown = document.querySelector("#countdown");

let gestureRecognizer;
let imageSegmenter;
let capturedPeople = [];
let cameraStream;
let cameraStartedAt = 0;
let isCapturing = false;
let isCountingDown = false;
let thumbStartedAt = 0;
let thumbArmed = true;
let latestHandLandmarks = null;
let lastGestureCheck = 0;
let lastVideoTime = -1;
let animationFrame = 0;

function trackEvent(name, parameters = {}) {
  if (typeof window.gtag === "function") {
    window.gtag("event", name, { example_id: "thumbs_up_to_click", ...parameters });
  }
}

function stopCamera(reason) {
  if (cameraStartedAt) {
    trackEvent("example_end", {
      duration_seconds: Math.round((performance.now() - cameraStartedAt) / 1000),
      end_reason: reason,
    });
    cameraStartedAt = 0;
  }
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
}

function setStatus(_label, message) {
  statusText.textContent = message;
}

function updateProgress() {
  progressDots.forEach((dot, index) => dot.classList.toggle("done", index < capturedPeople.length));
  progress.setAttribute("aria-label", `촬영 진행: ${capturedPeople.length} / ${MAX_CAPTURES}`);
}

function resizeOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(innerWidth * dpr);
  const height = Math.round(innerHeight * dpr);
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
    renderCaptures();
  }
}

function coverRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

function renderCaptures() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  [...capturedPeople].reverse().forEach((person) => {
    const rect = coverRect(person.width, person.height, overlay.width, overlay.height);
    overlayCtx.save();
    overlayCtx.translate(overlay.width, 0);
    overlayCtx.scale(-1, 1);
    overlayCtx.drawImage(person, rect.x, rect.y, rect.width, rect.height);
    overlayCtx.restore();
  });
}

async function loadVisionModels() {
  setStatus("LOADING", "제스처 인식을 준비하고 있어요");
  const {
    FilesetResolver,
    GestureRecognizer,
    ImageSegmenter,
  } = await import(VISION_MODULE);
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

  const gesturePromise = GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.48,
    minTrackingConfidence: 0.45,
    cannedGesturesClassifierOptions: { scoreThreshold: 0.5 },
  }).catch(() => {
    trackEvent("example_fallback", { component: "gesture_recognizer", reason: "gpu_unavailable" });
    return GestureRecognizer.createFromOptions(vision, {
      baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      cannedGesturesClassifierOptions: { scoreThreshold: 0.5 },
    });
  });

  const segmentPromise = ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: SEGMENT_MODEL, delegate: "CPU" },
    runningMode: "IMAGE",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });

  const [gestureResult, segmentResult] = await Promise.allSettled([gesturePromise, segmentPromise]);
  if (gestureResult.status === "fulfilled") gestureRecognizer = gestureResult.value;
  if (segmentResult.status === "fulfilled") imageSegmenter = segmentResult.value;
  if (!imageSegmenter) throw new Error("Person segmentation model unavailable");
}

async function startCamera() {
  trackEvent("example_start_attempt");
  startButton.hidden = true;
  startButton.disabled = true;
  setStatus("CAMERA", "카메라를 연결하는 중...");
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API unavailable");
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = cameraStream;
    await video.play();
    cameraStartedAt = performance.now();
    trackEvent("example_start");
    cameraStream.getVideoTracks()[0]?.addEventListener("ended", () => stopCamera("camera_ended"), { once: true });
    captureButton.hidden = false;
    captureButton.disabled = true;
    resizeOverlay();

    try {
      await loadVisionModels();
      captureButton.disabled = false;
      setStatus("1 / 3", "Show me a thumbs-up!");
    } catch (error) {
      console.error(error);
      trackEvent("example_error", { stage: "startup", error_type: "vision_model_load" });
      stopCamera("model_error");
      captureButton.hidden = true;
      startButton.disabled = false;
      startButton.hidden = false;
      setStatus("MODEL", "인물 인식을 준비하지 못했어요. 다시 시도해 주세요");
      return;
    }

    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(detectLoop);
  } catch (error) {
    console.error(error);
    stopCamera("startup_error");
    trackEvent("example_error", {
      stage: "startup",
      error_type: error instanceof Error ? error.name : "unknown",
    });
    startButton.disabled = false;
    startButton.hidden = false;
    setStatus(
      "CAMERA",
      window.isSecureContext
        ? "브라우저의 카메라 권한을 허용해 주세요"
        : "localhost 주소에서 열어 주세요",
    );
  }
}

function detectLoop(now) {
  animationFrame = requestAnimationFrame(detectLoop);
  if (!gestureRecognizer || isCapturing || capturedPeople.length >= MAX_CAPTURES) return;
  if (video.readyState < 2 || video.currentTime === lastVideoTime || now - lastGestureCheck < 120) return;

  lastVideoTime = video.currentTime;
  lastGestureCheck = now;

  try {
    const result = gestureRecognizer.recognizeForVideo(video, now);
    const gesture = result.gestures?.[0]?.[0];
    const landmarks = result.landmarks?.[0];
    if (landmarks) latestHandLandmarks = landmarks.map(({ x, y, z }) => ({ x, y, z }));
    if (isCountingDown) return;

    const cannedThumbUp = gesture?.categoryName === "Thumb_Up" && gesture.score >= 0.5;
    const isThumbUp = cannedThumbUp || isLandmarkThumbUp(landmarks);

    if (isThumbUp && thumbArmed) {
      if (!thumbStartedAt) thumbStartedAt = now;
      const elapsed = now - thumbStartedAt;
      setStatus("HOLD", elapsed > 350 ? "좋아요, 그대로!" : "엄지척을 유지해 주세요");
      if (elapsed >= 500) {
        thumbArmed = false;
        thumbStartedAt = 0;
        beginCountdown();
      }
    } else if (!isThumbUp) {
      thumbStartedAt = 0;
      if (!thumbArmed) thumbArmed = true;
      if (!isCapturing) setStatus(`${capturedPeople.length + 1} / 3`, "Show me a thumbs-up!");
    }
  } catch (error) {
    console.warn("Gesture recognition skipped", error);
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isLandmarkThumbUp(landmarks) {
  if (!landmarks?.[20]) return false;

  const palmSize = distance(landmarks[0], landmarks[9]);
  if (palmSize < 0.025) return false;

  const thumbExtended = distance(landmarks[4], landmarks[2]) > palmSize * 0.52;
  const thumbPointsUp = landmarks[2].y - landmarks[4].y > palmSize * 0.42;
  const thumbAbovePalm = landmarks[4].y < Math.min(landmarks[5].y, landmarks[9].y) - palmSize * 0.12;
  const foldedFingers = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(
    ([tip, joint]) => landmarks[tip].y > landmarks[joint].y - palmSize * 0.08,
  ).length;

  return thumbExtended && thumbPointsUp && thumbAbovePalm && foldedFingers >= 2;
}

function drawHandMask(context, landmarks, width, height) {
  if (!landmarks?.[20]) return;

  const points = landmarks.map((point) => ({ x: point.x * width, y: point.y * height }));
  const palmSize = distance(points[0], points[9]);
  const strokeWidth = Math.max(9, Math.min(Math.min(width, height) * 0.052, palmSize * 0.2));
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
  ];

  context.save();
  context.strokeStyle = "#fff";
  context.fillStyle = "#fff";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = strokeWidth;
  context.beginPath();
  connections.forEach(([from, to]) => {
    context.moveTo(points[from].x, points[from].y);
    context.lineTo(points[to].x, points[to].y);
  });
  context.stroke();

  context.beginPath();
  [0, 1, 5, 9, 13, 17].forEach((index, order) => {
    const point = points[index];
    if (order === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.fill();

  context.beginPath();
  context.arc(points[4].x, points[4].y, strokeWidth * 0.48, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function keepLargestPersonRegion(confidence, width, height, threshold = 0.18) {
  const labels = new Int32Array(confidence.length);
  const queue = new Int32Array(confidence.length);
  let nextLabel = 1;
  let largestLabel = 0;
  let largestSize = 0;

  for (let start = 0; start < confidence.length; start += 1) {
    if (labels[start] || confidence[start] < threshold) continue;

    let head = 0;
    let tail = 0;
    let size = 0;
    queue[tail++] = start;
    labels[start] = nextLabel;

    while (head < tail) {
      const index = queue[head++];
      size += 1;
      const x = index % width;
      const neighbors = [index - width, index + width];
      if (x > 0) neighbors.push(index - 1);
      if (x < width - 1) neighbors.push(index + 1);

      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= confidence.length) continue;
        if (labels[neighbor] || confidence[neighbor] < threshold) continue;
        labels[neighbor] = nextLabel;
        queue[tail++] = neighbor;
      }
    }

    if (size > largestSize) {
      largestSize = size;
      largestLabel = nextLabel;
    }
    nextLabel += 1;
  }

  const region = new Uint8Array(confidence.length);
  if (!largestLabel) return region;
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] === largestLabel) region[index] = 1;
  }
  return region;
}

async function makeCutout() {
  const source = document.createElement("canvas");
  source.width = video.videoWidth;
  source.height = video.videoHeight;
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(video, 0, 0, source.width, source.height);

  if (!imageSegmenter) throw new Error("Person segmentation model unavailable");

  const result = imageSegmenter.segment(source);
  const confidenceMasks = result.confidenceMasks ?? [];
  const maskImage = confidenceMasks[0];
  if (!maskImage) return source;

  const firstMask = maskImage.getAsFloat32Array();
  const mask = confidenceMasks.length > 1
    ? Float32Array.from(firstMask, (backgroundConfidence) => 1 - backgroundConfidence)
    : firstMask;
  const maskWidth = maskImage.width;
  const maskHeight = maskImage.height;
  const personRegion = keepLargestPersonRegion(mask, maskWidth, maskHeight);
  const smallMask = document.createElement("canvas");
  smallMask.width = maskWidth;
  smallMask.height = maskHeight;
  const smallMaskCtx = smallMask.getContext("2d");
  const maskPixels = new Uint8ClampedArray(maskWidth * maskHeight * 4);

  for (let index = 0; index < mask.length; index += 1) {
    const normalized = personRegion[index]
      ? Math.max(0, Math.min(1, (mask[index] - 0.16) / 0.56))
      : 0;
    const alpha = normalized * normalized * (3 - 2 * normalized);
    const offset = index * 4;
    maskPixels[offset] = 255;
    maskPixels[offset + 1] = 255;
    maskPixels[offset + 2] = 255;
    maskPixels[offset + 3] = Math.round(alpha * 255);
  }
  smallMaskCtx.putImageData(new ImageData(maskPixels, maskWidth, maskHeight), 0, 0);

  const fullMask = document.createElement("canvas");
  fullMask.width = source.width;
  fullMask.height = source.height;
  const fullMaskCtx = fullMask.getContext("2d");
  fullMaskCtx.imageSmoothingEnabled = true;
  fullMaskCtx.imageSmoothingQuality = "high";
  fullMaskCtx.drawImage(smallMask, 0, 0, source.width, source.height);
  drawHandMask(fullMaskCtx, latestHandLandmarks, source.width, source.height);

  const featheredMask = document.createElement("canvas");
  featheredMask.width = source.width;
  featheredMask.height = source.height;
  const featheredMaskCtx = featheredMask.getContext("2d");
  featheredMaskCtx.filter = `blur(${Math.max(0.6, Math.min(source.width, source.height) * 0.0008)}px)`;
  featheredMaskCtx.drawImage(fullMask, 0, 0);

  const cutout = document.createElement("canvas");
  cutout.width = source.width;
  cutout.height = source.height;
  const cutoutCtx = cutout.getContext("2d");
  cutoutCtx.drawImage(source, 0, 0);
  cutoutCtx.globalCompositeOperation = "destination-in";
  cutoutCtx.drawImage(featheredMask, 0, 0);

  result.confidenceMasks?.forEach((item) => item.close());
  result.categoryMask?.close();
  return cutout;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function beginCountdown() {
  if (isCountingDown || isCapturing || capturedPeople.length >= MAX_CAPTURES || video.readyState < 2) return;

  isCountingDown = true;
  captureButton.disabled = true;
  try {
    for (const number of [3, 2, 1]) {
      countdown.textContent = number;
      countdown.hidden = false;
      await wait(1000);
    }
    countdown.hidden = true;
    await capturePerson();
  } finally {
    countdown.hidden = true;
    isCountingDown = false;
    if (capturedPeople.length < MAX_CAPTURES) captureButton.disabled = false;
  }
}

async function capturePerson() {
  if (isCapturing || capturedPeople.length >= MAX_CAPTURES || video.readyState < 2) return;
  isCapturing = true;
  captureButton.disabled = true;
  setStatus("CAPTURE", "사진을 찍고 있어요");
  flash.classList.remove("fire");
  void flash.offsetWidth;
  flash.classList.add("fire");

  try {
    const cutout = await makeCutout();
    capturedPeople.push(cutout);
    trackEvent("example_capture", { capture_number: capturedPeople.length });
    updateProgress();
    renderCaptures();

    if (capturedPeople.length >= MAX_CAPTURES) {
      trackEvent("example_complete", { capture_count: capturedPeople.length });
      setStatus("DONE", "세 번의 순간이 완성됐어요");
      captureButton.hidden = true;
      resetButton.hidden = false;
    } else {
      setStatus(`${capturedPeople.length + 1} / 3`, "Show me a thumbs-up!");
    }
  } catch (error) {
    console.error(error);
    trackEvent("example_error", { stage: "capture", error_type: "cutout_failed" });
    setStatus("RETRY", "촬영하지 못했어요. 다시 시도해 주세요");
  } finally {
    isCapturing = false;
    captureButton.disabled = false;
  }
}

function resetExperience() {
  trackEvent("example_reset");
  capturedPeople = [];
  thumbArmed = true;
  thumbStartedAt = 0;
  latestHandLandmarks = null;
  isCountingDown = false;
  countdown.hidden = true;
  updateProgress();
  renderCaptures();
  resetButton.hidden = true;
  captureButton.hidden = false;
  setStatus("1 / 3", "Show me a thumbs-up!");
}

startButton.addEventListener("click", startCamera);
captureButton.addEventListener("click", beginCountdown);
resetButton.addEventListener("click", resetExperience);
window.addEventListener("resize", resizeOverlay);
window.addEventListener("pagehide", () => stopCamera("page_exit"));
resizeOverlay();
startCamera();
