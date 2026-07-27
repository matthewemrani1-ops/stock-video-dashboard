import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";

const settingsRef = doc(db, "config", "settings");

export async function openSettings() {
  const snap = await getDoc(settingsRef);
  const s = snap.exists() ? snap.data() : { trackedHandles: [], scheduleTime: "07:00", topN: 15 };
  document.getElementById("trackedHandles").value = (s.trackedHandles || []).join("\n");
  document.getElementById("scheduleTime").value = s.scheduleTime || "07:00";
  document.getElementById("topN").value = s.topN ?? 15;
  document.getElementById("settingsOverlay").classList.add("show");
}

export function closeSettings() {
  document.getElementById("settingsOverlay").classList.remove("show");
}

export async function saveSettings() {
  const trackedHandles = document
    .getElementById("trackedHandles")
    .value.split(/\n+/)
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean);
  const scheduleTime = document.getElementById("scheduleTime").value.trim() || "07:00";
  const topN = parseInt(document.getElementById("topN").value, 10) || 15;
  await setDoc(settingsRef, { trackedHandles, scheduleTime, topN });
  closeSettings();
}
