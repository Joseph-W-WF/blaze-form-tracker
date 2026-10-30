import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
// Grab the HTML elements we need
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("status");
const angleText = document.getElementById("angleText");

// Ignore a leg if any of its joints is less visible than this (0 to 1)
const MIN_VISIBILITY = 0.5;

// MediaPipe landmark numbers for each leg (the person's own left/right)
const LEFT_LEG = { hip: 23, knee: 25, ankle: 27 };
const RIGHT_LEG = { hip: 24, knee: 26, ankle: 28 };

let poseLandmarker;
let drawingUtils;
let lastVideoTime = -1;
// Turn on the webcam and show it in the <video>
async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 }
  });
  video.srcObject = stream;

  // Wait until the video knows its own size
  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play();

  // Make the canvas's drawing size match the video
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}
// Download and set up the pose model
async function loadModel() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1
  });

  drawingUtils = new DrawingUtils(ctx);
}
// Turn a 0-1 landmark into real pixel positions on the video
function toPixels(landmark) {
  return {
    x: landmark.x * video.videoWidth,
    y: landmark.y * video.videoHeight
  };
}
// Angle in degrees at point b, between the arrows b->a and b->c
function calculateAngle(a, b, c) {
  const arrowA = { x: a.x - b.x, y: a.y - b.y };
  const arrowC = { x: c.x - b.x, y: c.y - b.y };

  const dot = arrowA.x * arrowC.x + arrowA.y * arrowC.y;
  const lengthA = Math.hypot(arrowA.x, arrowA.y);
  const lengthC = Math.hypot(arrowC.x, arrowC.y);

  // Two joints on top of each other: no sensible angle
  if (lengthA === 0 || lengthC === 0) {
    return null;
  }

  let cosAngle = dot / (lengthA * lengthC);
  // Rounding can give e.g. 1.0000001, which would make Math.acos return NaN
  cosAngle = Math.min(1, Math.max(-1, cosAngle));

  const radians = Math.acos(cosAngle);
  return radians * (180 / Math.PI);
}
// A leg is only as visible as its least visible joint
function legVisibility(landmarks, leg) {
  return Math.min(
    landmarks[leg.hip].visibility,
    landmarks[leg.knee].visibility,
    landmarks[leg.ankle].visibility
  );
}
// Knee angle of the clearest leg, or null if neither leg is clear enough
function getKneeAngle(landmarks) {
  const leftVisibility = legVisibility(landmarks, LEFT_LEG);
  const rightVisibility = legVisibility(landmarks, RIGHT_LEG);

  // Side view: the leg nearer the camera is usually the clearer one
  let leg = LEFT_LEG;
  let side = "left";
  let visibility = leftVisibility;
  if (rightVisibility > leftVisibility) {
    leg = RIGHT_LEG;
    side = "right";
    visibility = rightVisibility;
  }

  if (visibility < MIN_VISIBILITY) {
    return null;
  }

  const hip = toPixels(landmarks[leg.hip]);
  const knee = toPixels(landmarks[leg.knee]);
  const ankle = toPixels(landmarks[leg.ankle]);
  const angle = calculateAngle(hip, knee, ankle);

  if (angle === null) {
    return null;
  }
  return { angle: angle, side: side, visibility: visibility };
}
// Show the knee angle under the video
function showKneeAngle(landmarks) {
  if (!landmarks) {
    angleText.textContent = "No person detected";
    return;
  }

  const knee = getKneeAngle(landmarks);
  if (knee === null) {
    angleText.textContent = "Can't see your legs clearly";
    return;
  }

  angleText.textContent =
    Math.round(knee.angle) + "° (" + knee.side + " leg, visibility " +
    knee.visibility.toFixed(2) + ")";
}
// Runs every frame: detect pose, draw skeleton
function detectLoop() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const result = poseLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const landmarks of result.landmarks) {
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS);
      drawingUtils.drawLandmarks(landmarks, { radius: 3 });
    }

    // numPoses is 1, so the person (if any) is always result.landmarks[0]
    showKneeAngle(result.landmarks[0]);
  }
  requestAnimationFrame(detectLoop);
}
// When the button is clicked
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    statusText.textContent = "Loading AI model...";
    await loadModel();
    statusText.textContent = "Starting camera...";
    await startWebcam();
    statusText.textContent = "Ready";
    detectLoop(); // start the per-frame detect-and-draw loop
  } catch (err) {
    statusText.textContent = "Error: " + err.message;
    startBtn.disabled = false;
  }
});