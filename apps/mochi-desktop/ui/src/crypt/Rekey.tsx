import { useEffect, useRef, useState } from "react";

import { errorText } from "../browser/format";
import type { ArchiveSummary } from "../ipc/browse";
import { listEnvelopes } from "../ipc/crypt";
import type { EnvelopeView } from "../ipc/crypt";
import { cancelJob, startJob } from "../ipc/jobs";
import type { JobEvent, JobOutcome, JobRequest } from "../ipc/jobs";
import { chooseDestination } from "../ipc/write";
import { EncryptionNotes, PassphraseForm } from "./PassphraseForm";
import { REENCRYPT_NOTE, REMOVE_NOT_REVOCATION, rekeyLines } from "./messages";

export interface RekeyProps {
  /** The open archive, if any. */
  archive: ArchiveSummary | null;
  /**
   * A rewrap committed: the archive as it now stands, or `null` when it could
   * not be opened again with the key held (the caller closes it).
   */
  onChanged: (archive: ArchiveSummary | null) => void;
}

type Mode = "closed" | "add" | "remove" | "reencrypt";
type Run = { state: "idle" } | { state: "running"; jobId: number | null } | { state: "done"; lines: string[] };

function outcomeLines(o: JobOutcome): string[] {
  switch (o.status) {
    case "completed":
      return o.rekey ? rekeyLines(o.rekey) : [`Completed: ${o.summary}.`];
    case "cancelled":
      return ["Cancelled. Nothing was changed."];
    case "failed":
      return [`Failed (${o.code}): ${o.message}`, "Nothing was changed."];
    case "aborted":
      return [`Stopped unexpectedly: ${o.message}`, "Open the archive again to see what it holds."];
  }
}

/**
 * Plan D5 rekey (docs/c11-encrypted.md): add a passphrase, remove one, or
 * re-encrypt to a new file. Everything is `mochi_core::rekey` in Rust. The
 * passphrase goes to Rust once, in the job request, and is not kept here.
 * Removal is not revocation, and the screen says so before it is done.
 */
export function Rekey({ archive, onChanged }: RekeyProps) {
  const [mode, setMode] = useState<Mode>("closed");
  const [envelopes, setEnvelopes] = useState<EnvelopeView[] | null>(null);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const changedRef = useRef(onChanged);
  useEffect(() => {
    changedRef.current = onChanged;
  });

  const handle = archive?.handle ?? null;
  const encrypted = archive?.profile.encrypted ?? false;

  const commits = archive?.commits.length ?? 0;
  useEffect(() => {
    if (handle === null || !encrypted) return;
    let live = true;
    listEnvelopes(handle).then(
      (l) => {
        if (live) setEnvelopes(l.envelopes);
      },
      (e: unknown) => {
        if (live) setError(errorText("Could not list the key envelopes", e));
      },
    );
    return () => {
      live = false;
    };
  }, [handle, encrypted, commits]);

  const busy = run.state === "running";

  const start = (request: JobRequest) =>
    new Promise<void>((resolve) => {
      setError(null);
      setRun({ state: "running", jobId: null });
      const onEvent = (event: JobEvent) => {
        if (event.event === "started") {
          setRun({ state: "running", jobId: event.job_id });
        } else if (event.event === "finished") {
          const o = event.outcome;
          setRun({ state: "done", lines: outcomeLines(o) });
          if (o.status === "completed" && o.rekey) {
            setMode("closed");
            if (o.rekey.action !== "reencrypted") changedRef.current(o.rekey.archive ?? null);
          }
          resolve();
        }
      };
      startJob(request, onEvent).catch((e: unknown) => {
        setRun({ state: "idle" });
        setError(errorText("Could not start", e));
        resolve();
      });
    });

  const chooseFile = () => {
    setError(null);
    chooseDestination().then(
      (view) => {
        if (view === null) return;
        setDestination(view.destination);
        setMode("reencrypt");
      },
      (e: unknown) => setError(errorText("Could not choose a location", e)),
    );
  };

  const cancel = () => {
    if (run.state === "running" && run.jobId !== null) void cancelJob(run.jobId).catch(() => false);
  };

  return (
    <section aria-labelledby="rekey-heading" className="rekey" data-testid="rekey">
      <h2 id="rekey-heading">Passphrases</h2>
      {!encrypted ? (
        <p className="note" data-testid="rekey-unavailable">
          {archive
            ? "This archive is not encrypted, so it has no passphrases to change."
            : "Open an encrypted archive to change its passphrases."}
        </p>
      ) : (
        <>
          <ul aria-label="Key envelopes" data-testid="envelopes">
            {(encrypted ? (envelopes ?? []) : []).map((e) => (
              <li key={e.envelope_id} data-testid="envelope">
                <span className="hash">{e.envelope_id}</span> · written by commit {e.written_by_commit} ·{" "}
                {e.kdf}
                {e.opened_with ? " · opened this archive in this session" : ""}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" data-testid="rekey-add" disabled={busy} onClick={() => setMode("add")}>
              Add a passphrase…
            </button>
            <button
              type="button"
              data-testid="rekey-remove"
              disabled={busy || (envelopes?.length ?? 0) < 2}
              title={(envelopes?.length ?? 0) < 2 ? "The last passphrase cannot be removed" : undefined}
              onClick={() => setMode("remove")}
            >
              Remove a passphrase…
            </button>
            <button type="button" data-testid="rekey-reencrypt" disabled={busy} onClick={chooseFile}>
              Re-encrypt to a new file…
            </button>
          </div>

          {mode === "add" && archive && (
            <div className="panel" role="group" aria-label="Add a passphrase" data-testid="rekey-panel">
              <h3>Add a passphrase</h3>
              <PassphraseForm
                testId="rekey-add-form"
                label="New passphrase"
                confirm
                submitLabel="Add passphrase"
                onSubmit={(p) => start({ kind: "add_passphrase", handle: archive.handle, passphrase: p })}
                onCancel={() => setMode("closed")}
              >
                <EncryptionNotes creating={false} />
              </PassphraseForm>
            </div>
          )}

          {mode === "remove" && archive && envelopes && (
            <div className="panel" role="group" aria-label="Remove a passphrase" data-testid="rekey-panel">
              <h3>Remove a passphrase</h3>
              <p className="warning" data-testid="not-revocation">
                {REMOVE_NOT_REVOCATION}
              </p>
              <p className="note">
                Choose the key envelope to remove. If you do not know which one a passphrase
                belongs to, the one marked as opening this archive is the one you typed.
              </p>
              <ul>
                {envelopes.map((e) => (
                  <li key={e.envelope_id}>
                    <span className="hash">{e.envelope_id}</span>
                    {e.opened_with ? " (opened this archive)" : ""}{" "}
                    <button
                      type="button"
                      data-testid="remove-envelope"
                      disabled={busy}
                      onClick={() =>
                        void start({
                          kind: "remove_passphrase",
                          handle: archive.handle,
                          envelope_id: e.envelope_id,
                        })
                      }
                    >
                      Remove this passphrase
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setMode("closed")} disabled={busy}>
                Close
              </button>
            </div>
          )}

          {mode === "reencrypt" && archive && (
            <div className="panel" role="group" aria-label="Re-encrypt" data-testid="rekey-panel">
              <h3>Re-encrypt to a new file</h3>
              <p className="note" data-testid="reencrypt-note">
                {REENCRYPT_NOTE}
              </p>
              {destination && <p>New file: {destination}</p>}
              <PassphraseForm
                testId="reencrypt-form"
                label="Passphrase for the new file"
                confirm
                submitLabel="Write the new file"
                onSubmit={(p) => start({ kind: "reencrypt", handle: archive.handle, passphrase: p })}
                onCancel={() => setMode("closed")}
              >
                <EncryptionNotes creating={false} />
              </PassphraseForm>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error" data-testid="rekey-error">
          {error}
        </p>
      )}
      {run.state === "running" && (
        <p data-testid="rekey-running">
          Working…{" "}
          <button type="button" data-testid="rekey-cancel" onClick={cancel} disabled={run.jobId === null}>
            Cancel
          </button>
        </p>
      )}
      {run.state === "done" && (
        <div role="status" data-testid="rekey-status">
          {run.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
    </section>
  );
}
