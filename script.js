// Grab the HTML elements we need
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("status");

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

// When the button is clicked
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    statusText.textContent = "Starting camera...";
    await startWebcam();
    statusText.textContent = "Camera on";
  } catch (err) {
    statusText.textContent = "Error: " + err.message;
    startBtn.disabled = false;
  }
});