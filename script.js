import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
// Grab the HTML elements we need
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("status");
const startOverlay = document.getElementById("startOverlay");
const angleText = document.getElementById("angleText");
const repText = document.getElementById("repText");
const stateText = document.getElementById("stateText");
const goodRepText = document.getElementById("goodRepText");
const feedbackText = document.getElementById("feedbackText");
const nameInput = document.getElementById("nameInput");
const finishBtn = document.getElementById("finishBtn");
const nextBtn = document.getElementById("nextBtn");
const summaryText = document.getElementById("summaryText");
const saveStatus = document.getElementById("saveStatus");

// Ignore a leg if any of its joints is less visible than this (0 to 1)
const MIN_VISIBILITY = 0.5;

// MediaPipe landmark numbers for each leg (the person's own left/right)
const LEFT_LEG = { hip: 23, knee: 25, ankle: 27 };
const RIGHT_LEG = { hip: 24, knee: 26, ankle: 28 };

// Rep counter thresholds (degrees). The gap between them stops jitter double-counting.
const DOWN_ANGLE = 110; // below this you are "down"
const UP_ANGLE = 160;   // above this you are back "up"

// Form rule: the lowest knee angle in a rep must reach this for good depth
const GOOD_DEPTH_ANGLE = 95;

// Noise guards
const SMOOTHING_FRAMES = 5; // average the knee angle over this many frames
const MIN_REP_MS = 500;     // a "rep" faster than this is noise, not a real squat

let squatState = "up";
let repCount = 0;
let goodRepCount = 0;
let lowestAngle = 180; // smallest knee angle seen during the current rep
let isCounting = true; // false after "Finish workout" until "Next person"
let downStartTime = 0;  // when the current rep went "down" (milliseconds)
let lockedSide = null;  // "left" or "right" once we've picked a leg to follow
let recentAngles = [];  // last few knee angles, for smoothing

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
// Average of the last few angles, so one noisy frame can't cause a rep
function smoothAngle(angle) {
  recentAngles.push(angle);
  if (recentAngles.length > SMOOTHING_FRAMES) {
    recentAngles.shift(); // drop the oldest
  }

  let total = 0;
  for (const recent of recentAngles) {
    total = total + recent;
  }
  return total / recentAngles.length;
}
// Smoothed knee angle of the leg we're following, or null if it isn't clear
function getKneeAngle(landmarks) {
  const leftVisibility = legVisibility(landmarks, LEFT_LEG);
  const rightVisibility = legVisibility(landmarks, RIGHT_LEG);

  // First clear frame: lock onto the clearer leg (side view: the near leg)
  if (lockedSide === null) {
    if (leftVisibility >= MIN_VISIBILITY && leftVisibility >= rightVisibility) {
      lockedSide = "left";
    } else if (rightVisibility >= MIN_VISIBILITY) {
      lockedSide = "right";
    } else {
      return null;
    }
  }

  // Only switch legs if the locked one has really gone and the other is clear
  if (lockedSide === "left" && leftVisibility < MIN_VISIBILITY && rightVisibility >= MIN_VISIBILITY) {
    lockedSide = "right";
    recentAngles = []; // don't mix angles from two different legs
  } else if (lockedSide === "right" && rightVisibility < MIN_VISIBILITY && leftVisibility >= MIN_VISIBILITY) {
    lockedSide = "left";
    recentAngles = [];
  }

  let leg = LEFT_LEG;
  let visibility = leftVisibility;
  if (lockedSide === "right") {
    leg = RIGHT_LEG;
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
  return { angle: smoothAngle(angle), side: lockedSide, visibility: visibility };
}
// Show the knee angle under the video, and return it (or null) for the counter
function showKneeAngle(landmarks) {
  if (!landmarks) {
    angleText.textContent = "No person detected";
    return null;
  }

  const knee = getKneeAngle(landmarks);
  if (knee === null) {
    angleText.textContent = "Can't see your legs clearly";
    return null;
  }

  angleText.textContent =
    Math.round(knee.angle) + "° (" + knee.side + " leg, visibility " +
    knee.visibility.toFixed(2) + ")";
  return knee;
}
// Up/down state machine: one rep = going down, then coming back up
function updateRepCounter(angle) {
  if (squatState === "up" && angle < DOWN_ANGLE) {
    squatState = "down";
    lowestAngle = angle; // start tracking the bottom of this rep
    downStartTime = performance.now();
  } else if (squatState === "down") {
    // Remember the deepest point while we're down
    if (angle < lowestAngle) {
      lowestAngle = angle;
    }

    if (angle > UP_ANGLE) {
      squatState = "up";
      const repDuration = performance.now() - downStartTime;

      if (repDuration >= MIN_REP_MS) {
        repCount = repCount + 1;
        judgeRep(lowestAngle);
      } else {
        console.log("Ignored a too-fast rep: " + Math.round(repDuration) + " ms");
      }
    }
  }

  repText.textContent = repCount;
  stateText.textContent = squatState;
}
// Form check, run once at the end of each rep
function judgeRep(lowest) {
  const lowestRounded = Math.round(lowest);

  if (lowest <= GOOD_DEPTH_ANGLE) {
    goodRepCount = goodRepCount + 1;
    feedbackText.textContent = "Good depth! (lowest " + lowestRounded + "°)";
    feedbackText.className = "good";
  } else {
    feedbackText.textContent =
      "Go a bit lower - aim for thighs parallel (lowest " + lowestRounded + "°)";
    feedbackText.className = "bad";
  }

  goodRepText.textContent = goodRepCount;
}
// Good-form reps as a whole-number percentage
function calculateFormScore() {
  if (repCount === 0) {
    return 0; // avoid dividing by zero
  }
  return Math.round((goodRepCount / repCount) * 100);
}
// Send one finished workout to Supabase (no video, just these four values)
async function saveWorkout(name, reps, goodReps, formScore) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/workouts", {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      // We're not allowed to read the table, so don't ask for the row back
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      name: name,
      reps: reps,
      good_reps: goodReps,
      form_score: formScore
    })
  });

  // fetch only throws on network failure, so check the status ourselves
  if (!response.ok) {
    const details = await response.text();
    throw new Error("status " + response.status + " " + details);
  }
}
// End the workout, show the summary and save it
async function finishWorkout() {
  const name = nameInput.value.trim();

  if (name === "") {
    summaryText.textContent = "Please type your first name first.";
    return;
  }
  if (repCount === 0) {
    summaryText.textContent = "Do at least one squat before finishing.";
    return;
  }

  isCounting = false;
  nameInput.disabled = true;
  finishBtn.disabled = true; // stop double-clicks saving twice

  const formScore = calculateFormScore();
  summaryText.textContent =
    "Well done " + name + "! " + repCount + " reps, " + goodRepCount +
    " with good depth. Form score: " + formScore + "%";
  saveStatus.textContent = "Saving...";

  try {
    await saveWorkout(name, repCount, goodRepCount, formScore);
    saveStatus.textContent = "Saved ✅";
    finishBtn.hidden = true;
  } catch (err) {
    console.error("Save failed:", err);
    saveStatus.textContent = "Couldn't save - press Finish workout to try again.";
    finishBtn.disabled = false;
  }

  nextBtn.hidden = false;
}
// Reset everything so the next person can start fresh
function resetWorkout() {
  repCount = 0;
  goodRepCount = 0;
  squatState = "up";
  lowestAngle = 180;
  lockedSide = null; // the next person might face the other way
  recentAngles = [];

  repText.textContent = repCount;
  goodRepText.textContent = goodRepCount;
  stateText.textContent = squatState;
  feedbackText.textContent = "Do a squat to get feedback.";
  feedbackText.className = "";

  nameInput.value = "";
  nameInput.disabled = false;
  summaryText.textContent = "";
  saveStatus.textContent = "";
  finishBtn.hidden = false;
  finishBtn.disabled = false;
  nextBtn.hidden = true;

  isCounting = true;
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
    const knee = showKneeAngle(result.landmarks[0]);

    // Only count on frames we trust, and only while a workout is running
    if (knee !== null && isCounting) {
      updateRepCounter(knee.angle);
    }
  }
  requestAnimationFrame(detectLoop);
}
finishBtn.addEventListener("click", finishWorkout);
nextBtn.addEventListener("click", resetWorkout);

// When the button is clicked
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    statusText.textContent = "Loading AI model...";
    await loadModel();
    statusText.textContent = "Starting camera...";
    await startWebcam();
    statusText.textContent = "Ready";
    startOverlay.hidden = true; // show the live video
    detectLoop(); // start the per-frame detect-and-draw loop
  } catch (err) {
    statusText.textContent = "Error: " + err.message;
    startBtn.disabled = false;
  }
});