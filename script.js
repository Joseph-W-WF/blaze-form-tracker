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
const countdownText = document.getElementById("countdown");
const angleText = document.getElementById("angleText");
const repText = document.getElementById("repText");
const targetText = document.getElementById("targetText");
const ringProgress = document.getElementById("ringProgress");
const timerText = document.getElementById("timerText");
const stateText = document.getElementById("stateText");
const goodRepText = document.getElementById("goodRepText");
const feedbackText = document.getElementById("feedbackText");
const muteBtn = document.getElementById("muteBtn");
const setupCard = document.getElementById("setupCard");
const nameInput = document.getElementById("nameInput");
const targetButtons = document.querySelectorAll(".target-btn");
const startWorkoutBtn = document.getElementById("startWorkoutBtn");
const setupMessage = document.getElementById("setupMessage");
const finishBtn = document.getElementById("finishBtn");
const doneCard = document.getElementById("doneCard");
const doneTitle = document.getElementById("doneTitle");
const doneReps = document.getElementById("doneReps");
const doneScore = document.getElementById("doneScore");
const doneTime = document.getElementById("doneTime");
const saveStatus = document.getElementById("saveStatus");
const retrySaveBtn = document.getElementById("retrySaveBtn");
const nextBtn = document.getElementById("nextBtn");

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

// Length of the progress ring's outline (circumference = 2 x pi x radius 54)
const RING_LENGTH = 2 * Math.PI * 54;

let squatState = "up";
let repCount = 0;
let goodRepCount = 0;
let lowestAngle = 180; // smallest knee angle seen during the current rep
let isCounting = false; // only true while a workout is running
let downStartTime = 0;  // when the current rep went "down" (milliseconds)
let lockedSide = null;  // "left" or "right" once we've picked a leg to follow
let recentAngles = [];  // last few knee angles, for smoothing

// Workout mode
let targetReps = 10;
let workoutName = "";
let workoutStartTime = 0;
let workoutSeconds = 0;
let timerInterval = null;

// Sound
let audioContext = null; // created on the first "Start workout" click
let isMuted = false;

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
        updateProgress();

        // Target reached: the workout ends by itself
        if (repCount >= targetReps) {
          finishWorkout();
        }
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
    beep(880); // high beep = good rep
  } else {
    feedbackText.textContent =
      "Go a bit lower - aim for thighs parallel (lowest " + lowestRounded + "°)";
    feedbackText.className = "bad";
    beep(330); // low beep = rep counted, but go deeper
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

// ---------- Workout mode ----------

// Show only the cards for the current phase:
// "waiting" (no camera yet), "setup", "countdown", "active" or "done"
function showPhase(phase) {
  setupCard.hidden = phase !== "setup";
  countdownText.hidden = phase !== "countdown";
  finishBtn.hidden = phase !== "active";
  doneCard.hidden = phase !== "done";
}
// Highlight the chosen target button and update the ring
function selectTarget(target) {
  targetReps = target;

  for (const button of targetButtons) {
    const isChosen = Number(button.dataset.target) === target;
    button.classList.toggle("selected", isChosen);
    button.setAttribute("aria-pressed", String(isChosen));
  }

  targetText.textContent = "of " + targetReps;
  updateProgress();
}
// Fill the ring: the outline is drawn as one dash, shifted by how much is left
function updateProgress() {
  const progress = Math.min(repCount / targetReps, 1);
  ringProgress.style.strokeDasharray = RING_LENGTH;
  ringProgress.style.strokeDashoffset = RING_LENGTH * (1 - progress);
}
// e.g. 75 seconds -> "1:15"
function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}
function updateTimer() {
  workoutSeconds = Math.floor((performance.now() - workoutStartTime) / 1000);
  timerText.textContent = formatTime(workoutSeconds);
}
// Pause for a number of milliseconds (used by the countdown)
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Short beep made by the browser itself (Web Audio API), no sound files needed
function beep(frequency) {
  if (isMuted || audioContext === null) {
    return;
  }

  const oscillator = audioContext.createOscillator(); // makes the tone
  const volume = audioContext.createGain();            // controls loudness
  oscillator.frequency.value = frequency;
  oscillator.connect(volume);
  volume.connect(audioContext.destination);

  // Fade out quickly so it sounds like a "beep", not a click
  const now = audioContext.currentTime;
  volume.gain.setValueAtTime(0.2, now);
  volume.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  oscillator.start(now);
  oscillator.stop(now + 0.15);
}
function toggleMute() {
  isMuted = !isMuted;

  if (isMuted) {
    muteBtn.textContent = "🔇 Muted";
  } else {
    muteBtn.textContent = "🔊 Sound on";
  }
  muteBtn.setAttribute("aria-pressed", String(isMuted));
}
// Put all the counters and displays back to zero
function resetCounters() {
  repCount = 0;
  goodRepCount = 0;
  squatState = "up";
  lowestAngle = 180;
  lockedSide = null; // the next person might face the other way
  recentAngles = [];
  workoutSeconds = 0;

  repText.textContent = repCount;
  goodRepText.textContent = goodRepCount;
  stateText.textContent = squatState;
  timerText.textContent = formatTime(0);
  updateProgress();
}
// Check the name, count down 3-2-1, then start counting
async function startWorkout() {
  const name = nameInput.value.trim();
  if (name === "") {
    setupMessage.textContent = "Please type your first name first.";
    nameInput.focus();
    return;
  }
  setupMessage.textContent = "";
  workoutName = name;

  // Browsers only allow sound after a click, so create the audio here
  if (audioContext === null) {
    audioContext = new AudioContext();
  }

  resetCounters();
  feedbackText.textContent = "Get into position...";
  feedbackText.className = "";
  showPhase("countdown");

  const steps = ["3", "2", "1", "Go!"];
  for (const step of steps) {
    countdownText.textContent = step;
    if (step === "Go!") {
      beep(880);
    } else {
      beep(520);
    }
    await wait(1000);
  }

  feedbackText.textContent = "Squat! Aim for " + targetReps + " reps.";
  workoutStartTime = performance.now();
  timerInterval = setInterval(updateTimer, 1000);
  isCounting = true;
  showPhase("active");
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
// Save the finished workout and show how it went
async function saveCurrentWorkout() {
  saveStatus.textContent = "Saving...";
  retrySaveBtn.hidden = true;

  try {
    await saveWorkout(workoutName, repCount, goodRepCount, calculateFormScore());
    saveStatus.textContent = "Saved ✅";
  } catch (err) {
    console.error("Save failed:", err);
    saveStatus.textContent = "Couldn't save.";
    retrySaveBtn.hidden = false;
  }
}
// Called when the target is reached or "Finish early" is pressed
async function finishWorkout() {
  // Already finished (e.g. target reached and button clicked at the same time)
  if (!isCounting) {
    return;
  }
  isCounting = false;
  clearInterval(timerInterval);
  updateTimer();

  // Nothing to save if no reps were done
  if (repCount === 0) {
    feedbackText.textContent = "No reps counted - workout cancelled.";
    feedbackText.className = "";
    showPhase("setup");
    return;
  }

  doneTitle.textContent = "Well done, " + workoutName + "!";
  doneReps.textContent = repCount;
  doneScore.textContent = calculateFormScore() + "%";
  doneTime.textContent = formatTime(workoutSeconds);
  showPhase("done");

  // Two rising beeps to say "finished"
  beep(660);
  await wait(180);
  beep(990);

  await saveCurrentWorkout();
}
// Get ready for the next person
function nextPerson() {
  resetCounters();
  nameInput.value = "";
  saveStatus.textContent = "";
  retrySaveBtn.hidden = true;
  feedbackText.textContent = "Type your name and pick a target.";
  feedbackText.className = "";
  showPhase("setup");
  nameInput.focus();
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

for (const button of targetButtons) {
  button.addEventListener("click", () => {
    selectTarget(Number(button.dataset.target));
  });
}
startWorkoutBtn.addEventListener("click", startWorkout);
finishBtn.addEventListener("click", finishWorkout);
retrySaveBtn.addEventListener("click", saveCurrentWorkout);
nextBtn.addEventListener("click", nextPerson);
muteBtn.addEventListener("click", toggleMute);

// Draw the empty ring before anything starts
updateProgress();

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
    feedbackText.textContent = "Type your name and pick a target.";
    showPhase("setup");
    detectLoop(); // start the per-frame detect-and-draw loop
  } catch (err) {
    statusText.textContent = "Error: " + err.message;
    startBtn.disabled = false;
  }
});
