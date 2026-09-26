"use client";

/**
 * A JSON value, as a tree a person can open (#37).
 *
 * Written here rather than taken from npm. It is about a hundred lines: every
 * object and array is a `<details>`, so a node opens and closes with no state
 * and no script beyond React, leaves are coloured by type through `chat.css`,
 * and one button copies the whole value. The packages that do this ship their
 * own themes, icons and stylesheets. Each is one more dependency in the image a
 * forker builds, and a theme we would spend the same lines overriding. Nothing
 * here loads a remote asset.
 *
 * **What it prints is the value, not a summary of it.** Strings are quoted and
 * escaped exactly as `JSON.stringify` writes them, and the copy button copies
 * `JSON.stringify(value, null, 2)`, so what a person pastes is what was on the
 * wire.
 */
import { useState } from "react";

/** Nodes deeper than this start closed. The top of a loan record is what a reader wants first. */
const OPEN_DEPTH = 1;

export function JsonView({ value, label }: { value: unknown; label: string }) {
  return (
    <div className="json-view" data-json={label}>
      <div className="json-view-bar">
        <span className="json-view-label">{label}</span>
        <CopyButton text={JSON.stringify(value, null, 2) ?? "undefined"} />
      </div>
      <div className="json-view-tree">
        <Node value={value} depth={0} />
      </div>
    </div>
  );
}

function Node({ value, depth, name }: { value: unknown; depth: number; name?: string }) {
  const key =
    name === undefined ? null : (
      <>
        <span className="json-key">{JSON.stringify(name)}</span>
        <span className="json-punct">: </span>
      </>
    );

  if (value !== null && typeof value === "object") {
    const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
      ? value.map((item) => [undefined, item])
      : Object.entries(value as Record<string, unknown>);
    const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
    if (entries.length === 0) {
      return (
        <div className="json-line">
          {key}
          <span className="json-punct">
            {open}
            {close}
          </span>
        </div>
      );
    }
    return (
      <details className="json-node" open={depth < OPEN_DEPTH}>
        <summary className="json-line">
          {key}
          <span className="json-punct">{open}</span>
          <span className="json-count">
            {entries.length} {Array.isArray(value) ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}
          </span>
        </summary>
        <div className="json-children">
          {entries.map(([childName, child], index) => (
            <Node key={childName ?? index} value={child} depth={depth + 1} {...(childName === undefined ? {} : { name: childName })} />
          ))}
        </div>
        <div className="json-line json-punct">{close}</div>
      </details>
    );
  }

  return (
    <div className="json-line">
      {key}
      <Leaf value={value} />
    </div>
  );
}

function Leaf({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="json-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
  if (value === null) return <span className="json-null">null</span>;
  // Not JSON at all. Shown for what it is rather than dropped.
  return <span className="json-null">{String(value)}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="json-copy"
      data-action="copy-json"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
