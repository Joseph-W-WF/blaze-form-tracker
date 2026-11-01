import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Grab the HTML elements we need
const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const message = document.getElementById("message");
const results = document.getElementById("results");
const logoutBtn = document.getElementById("logoutBtn");
const dayList = document.getElementById("dayList");

// Kept in memory only: closing the tab logs you out
let accessToken = null;

// Swap email + password for an access token (the "wristband")
async function logIn(email, password) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email: email, password: password })
  });

  if (!response.ok) {
    throw new Error("login failed (status " + response.status + ")");
  }

  const data = await response.json();
  return data.access_token;
}
// Read all workouts, newest first. Only works with a valid token (RLS).
async function loadWorkouts() {
  const url = SUPABASE_URL +
    "/rest/v1/workouts?select=name,reps,good_reps,form_score,created_at&order=created_at.desc";

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + accessToken
    }
  });

  if (!response.ok) {
    throw new Error("couldn't load workouts (status " + response.status + ")");
  }
  return await response.json();
}
// Tell Supabase to cancel the token, then forget it
async function logOut() {
  try {
    await fetch(SUPABASE_URL + "/auth/v1/logout", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + accessToken
      }
    });
  } catch (err) {
    console.error("Logout request failed:", err); // we still forget the token below
  }

  accessToken = null;
  dayList.textContent = "";
  results.hidden = true;
  loginForm.hidden = false;
  message.textContent = "Logged out.";
}
// e.g. "Sat 1 Nov" in the leader's local time
function formatDay(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
// Put each workout into a bucket for its day. A Map keeps the days in order.
function groupByDay(workouts) {
  const days = new Map();

  for (const workout of workouts) {
    const day = formatDay(workout.created_at);
    if (!days.has(day)) {
      days.set(day, []);
    }
    days.get(day).push(workout);
  }
  return days;
}
// Short message the leader can paste into the squad group chat
function buildSummary(day, workouts) {
  let text = "Blaze squats - " + day + " ✅";

  for (const workout of workouts) {
    text = text + "\n" + workout.name + " - " + workout.reps +
      " reps (good form " + workout.form_score + "%)";
  }
  return text;
}
// One section per day: heading, list of workouts, copy button
function showWorkouts(workouts) {
  dayList.textContent = "";

  if (workouts.length === 0) {
    message.textContent = "No workouts in the last 3 days yet.";
    return;
  }

  const days = groupByDay(workouts);

  // Each entry in the Map is a [day, workoutsForThatDay] pair
  for (const [day, dayWorkouts] of days) {
    const section = document.createElement("section");

    const heading = document.createElement("h2");
    heading.textContent = day + " (" + dayWorkouts.length + " done)";
    section.appendChild(heading);

    const list = document.createElement("ul");
    for (const workout of dayWorkouts) {
      const item = document.createElement("li");
      // textContent, never innerHTML: names are typed by the public (stops XSS)
      item.textContent = workout.name + " - " + workout.reps + " reps, " +
        workout.good_reps + " good depth, form " + workout.form_score + "%";
      list.appendChild(item);
    }
    section.appendChild(list);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy summary";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildSummary(day, dayWorkouts));
        copyBtn.textContent = "Copied ✅";
      } catch (err) {
        console.error("Copy failed:", err);
        copyBtn.textContent = "Couldn't copy";
      }
    });
    section.appendChild(copyBtn);

    dayList.appendChild(section);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the form reloading the page
  message.textContent = "Logging in...";

  try {
    accessToken = await logIn(emailInput.value.trim(), passwordInput.value);
    passwordInput.value = ""; // don't leave the password sitting in the box
    loginForm.hidden = true;
    results.hidden = false;

    message.textContent = "Loading workouts...";
    const workouts = await loadWorkouts();
    message.textContent = "";
    showWorkouts(workouts);
  } catch (err) {
    console.error(err);
    message.textContent = "Something went wrong: " + err.message;
  }
});

logoutBtn.addEventListener("click", logOut);
