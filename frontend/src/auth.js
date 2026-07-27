import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth } from "./firebase-init.js";

export function requireOwner(onSignedIn) {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      onSignedIn(user);
    } else {
      document.getElementById("loginGate").style.display = "block";
    }
  });
}

export function signIn() {
  signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  signOut(auth);
}
