// dom.js - the elements the page ships with, looked up once.
//
// Only what index.html holds: everything the bar, the cards and the composer draw is built as it is needed and
// never queried back. An element that belongs to exactly one part of the interface (the microphone button, the
// icon link) is looked up there instead, so this list stays the page's frame rather than a bag of ids.

export const tabbar = document.getElementById("tabbar");
export const termEl = document.getElementById("term");
export const overlay = document.getElementById("overlay");
export const card = document.getElementById("card");
export const curtain = document.getElementById("curtain");
export const curtainCard = document.getElementById("curtain-card");
export const input = document.getElementById("input");
export const sendBtn = document.getElementById("send");
export const attachBtn = document.getElementById("attach");
export const fileInput = document.getElementById("file-input");
export const note = document.getElementById("note");
export const strip = document.getElementById("strip");

// Every icon in the bar is drawn rather than shipped, because the bar is rebuilt from scratch on every frame.
export const SVG_NS = "http://www.w3.org/2000/svg";
