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