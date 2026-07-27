import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBcLPTEIjI9aUBHD1mjEPsQhc-EHpFvSN0",
  authDomain: "signal-stock-digest-67e26.firebaseapp.com",
  projectId: "signal-stock-digest-67e26",
  storageBucket: "signal-stock-digest-67e26.firebasestorage.app",
  messagingSenderId: "622182804343",
  appId: "1:622182804343:web:ff794cd85dd69df0da8f72",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// liveQuote is a plain HTTP function (onRequest), not callable, so the
// frontend fetches it directly rather than through the Functions SDK.
export const FUNCTIONS_BASE_URL = "https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net";
