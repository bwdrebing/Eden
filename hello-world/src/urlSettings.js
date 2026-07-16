// ------------------------------------------------------------------ //
//  URL settings serialization
//
//  Encodes the app's settings into a single compact hash carried in the
//  `?s=` query param. The hash is updated in place (history.replaceState)
//  as the user changes settings, so the URL always mirrors the app, and
//  any session that opens the URL reconstructs the same state.
//
//  Layout of the decoded object:
//    { reflection: {...} }
//  Each area of settings owns one named slice. Slices are merged
//  independently, so writing one slice never disturbs the others — leaving
//  room to add more slices later without changing this module.
// ------------------------------------------------------------------ //
import { useEffect, useRef } from "react";

const PARAM = "s";

// UTF-8-safe base64url so the hash stays inside one URL query value with
// no characters that need percent-encoding.
function toB64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encode(obj) {
  return toB64url(JSON.stringify(obj));
}
function decode(str) {
  try {
    return JSON.parse(fromB64url(str));
  } catch (e) {
    return null;
  }
}

function readUrl() {
  if (typeof window === "undefined") return {};
  try {
    const raw = new URLSearchParams(window.location.search).get(PARAM);
    if (!raw) return {};
    const parsed = decode(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeUrl(state) {
  if (typeof window === "undefined" || !window.history) return;
  const params = new URLSearchParams(window.location.search);
  if (state && Object.keys(state).length) params.set(PARAM, encode(state));
  else params.delete(PARAM);
  const qs = params.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
  window.history.replaceState(null, "", url);
}

// In-memory copy of the decoded state. All reads and writes go through it
// so concurrent slices never clobber one another, and writes are coalesced
// into one history.replaceState per animation frame — dragging a slider can
// fire dozens of updates a frame, and browsers rate-limit the history API.
let cache = null;
let scheduled = false;

function ensureCache() {
  if (cache === null) cache = readUrl();
  return cache;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    writeUrl(cache);
  };
  if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

export function readSlice(key) {
  const v = ensureCache()[key];
  return v && typeof v === "object" ? v : null;
}

export function writeSlice(key, slice) {
  ensureCache()[key] = slice;
  schedule();
}

function collect(fields) {
  const out = {};
  for (const k in fields) out[k] = fields[k][0];
  return out;
}

// Two-way binding between a studio's settings and its URL slice.
//   fields: { fieldName: [value, setter], ... }
// On mount it applies any values found in the URL (so a shared link
// reconstructs the state), then keeps the slice in sync whenever any
// value changes.
//
// The tricky part is that applied values arrive one render later than the
// mount effect (React state updates are async). The `last` guard tracks the
// serialized value we last committed to the URL and only writes on a real
// change, so the pre-commit default values are never flushed over a restored
// slice — the URL only ever gains the restored (or user-edited) values.
export function useUrlSync(key, fields) {
  const booted = useRef(false);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  const serialized = JSON.stringify(collect(fields));
  const last = useRef(serialized); // defaults on the first render

  useEffect(() => {
    const slice = readSlice(key);
    if (slice) {
      const f = fieldsRef.current;
      for (const name in slice) {
        if (f[name] && slice[name] !== undefined) f[name][1](slice[name]);
      }
      // Applied values land next render; the write effect flushes them then.
    } else {
      // Nothing saved yet — seed the slice so the URL carries this studio's
      // settings even before the user changes anything.
      const seed = collect(fieldsRef.current);
      last.current = JSON.stringify(seed);
      writeSlice(key, seed);
    }
    booted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!booted.current || serialized === last.current) return;
    last.current = serialized;
    writeSlice(key, JSON.parse(serialized));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
}
