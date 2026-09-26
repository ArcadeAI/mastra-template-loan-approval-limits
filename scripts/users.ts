/**
 * `bun run users` — the people who can use the app, added from the terminal
 * (#31). There is no open sign-up: `/sign-up/email` is not routed, so this is
 * how somebody comes to exist.
 *
 *     bun run users add <email> --name <name> --role <role> [--clearance <n>] [--password <p>]
 *     bun run users list
 *     bun run users set-role <email> <role>
 *     bun run users set-clearance <email> <n>
 *     bun run users remove <email>
 *     bun run users seed-demo [--alice <email>] [--bob <email>] [--charlie <email>] [--michael <email>] [--password <p>]
 *
 * ## Two halves, one person
 *
 * A user is two rows in two databases, joined on the lowercase email:
 *
 *     identity        idp.db         a Better Auth `user` and its `credential`
 *                                    account: who they are, so they can sign in
 *     control plane   governance.db  a `subjects` row: role and clearance, so
 *                                    the hooks know what they may do
 *
 * Signing in without a subject gets you denied at every hook ("an
 * administrator must register the identity"); a subject without an identity
 * can never sign in. So `add` writes both or neither: the identity first, then
 * the subject, and if the subject cannot be written the identity is removed
 * again. Each half is written through the module that owns its file, and
 * identity only through the provider's own tool, `scripts/identity/people.ts`,
 * which hands back people and nothing that can sign a token.
 *
 * ## The role is mandatory, and read from the policy
 *
 * `--role` must be a role the policy knows: one a `subjects` row holds, one a
 * rule narrows on, or one the shipped fixture's cast holds. `--clearance` is a
 * non-negative whole number, and required unless `/access` hides the approval
 * tool from the role (today `credit_analyst`, by
 * `access.analysts-cannot-see-approve`): there is nothing for a clearance to
 * cap, so it defaults to 0.
 *
 * ## Every change is recorded
 *
 * Changing somebody's clearance is a governance action, so every add, role
 * change, clearance change and removal appends a row to `governance.db`'s
 * `subject_changes` in the same transaction, and prints it. The table is
 * append-only. It is not `audit_log`, which is the hooks' decisions, and it
 * is not on the panel.
 *
 * ## The running app sees it at once
 *
 * The writes go straight to the two databases, the way `bun run oauth-client`
 * does. A running app reads the new identity on the next sign-in, and its
 * policy cache notices `policy_revision` move within one poll, so no restart.
 *
 * ## Passwords
 *
 * Without `--password`, `add` and `seed-demo` generate one and print it once.
 * Only its scrypt hash is stored; it is never logged or written anywhere else.
 * A `--password` typed on the command line lands in your shell history.
 *
 * ## Requesters need an Arcade account
 *
 * Asking for an approval goes through Arcade's stock Slack provider, which
 * Arcade sends through its own user verifier, and that one only lets members
 * of the Arcade project through (DESIGN.md → Slack and Arcade accounts). So
 * for every user who can request an approval, `add` and `seed-demo` print
 * that their email must be invited to the project, and where.
 *
 * Reads `.env` and `.env.local` the way `bun run dev` does, so it writes the
 * databases the app opens: `IDP_DB_PATH` and `GOVERNANCE_DB_PATH`, `./idp.db`
 * and `./governance.db` when unset.
 */
import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

import { readConfig } from "../lib/control-plane/config.ts";
import { loadSeed, openGovernance } from "../lib/control-plane/policy-store.ts";
import {
  addSubject,
  hiddenFrom,
  knownRoles,
  listSubjects,
  NoSuchSubjectError,
  readSubject,
  removeSubject,
  setSubjectClearance,
  setSubjectRole,
  subjectId,
  type NewSubject,
  type SubjectChange,
} from "../lib/control-plane/subjects.ts";
import { openPeopleStore, type People } from "./identity/people.ts";

/** Where a requester is invited. One constant, so the wording has one place to be corrected. */
const ARCADE_INVITE_WHERE = "Arcade dashboard (https://api.arcade.dev/dashboard), your project, Members";

/** The tool `/access` hides from a role with no approval authority. PascalCase, as measured (#35). */
const APPROVE_TOOL = "ApproveLoan";
/** The tool that asks for an approval, and so goes through Arcade's Slack provider. */
const REQUEST_TOOL = "RequestApproval";

/** Better Auth's own bounds on a password (`minPasswordLength`, `maxPasswordLength` defaults). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const USAGE = `usage: bun run users <command>

  add <email> --name <name> --role <role> [--clearance <n>] [--password <p>]
  list
  set-role <email> <role>
  set-clearance <email> <n>
  remove <email>
  seed-demo [--alice <email>] [--bob <email>] [--charlie <email>] [--michael <email>] [--password <p>]`;

/** A refusal: said on stderr, exit 1, and nothing written. */
class Refusal extends Error {}
/** A command line this script cannot read: exit 2. */
class UsageError extends Error {}

const config = readConfig();
const seedOptions = {
  loanToolkit: config.loanToolkit,
  approvalsToolkit: config.approvalsToolkit,
  personaEmails: config.personaEmails,
};
const actor = `cli:${userInfo().username}`;

// ---------------------------------------------------------------------------
// Reading the command line
// ---------------------------------------------------------------------------

function parseEmail(raw: string | undefined, what = "email"): string {
  const email = raw?.trim().toLowerCase() ?? "";
  // The shape Better Auth and the subject's own schema accept; the domain is not checked.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UsageError(`${what} ${raw === undefined ? "is missing" : `"${raw}" is not an email address`}`);
  }
  return email;
}

function parseClearance(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new UsageError(`clearance "${raw}" is not a non-negative whole number`);
  }
  return value;
}

function parsePassword(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
    throw new UsageError(`--password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
  }
  return raw;
}

/** 20 characters from 62, about 119 bits, drawn without modulo bias. */
function generatePassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && out.length < 20) out += alphabet[byte % 62];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two databases
// ---------------------------------------------------------------------------

function openControlPlane(): Database {
  const db = openGovernance(config.dbPath, seedOptions);
  return db;
}

/** Identity through the provider's own tool, which hands back people and nothing that signs. */
function openIdentity(): Promise<People> {
  return openPeopleStore();
}

/** The shipped fixture's cast, for the roles it names and for `seed-demo`. */
function fixtureCast() {
  return loadSeed(seedOptions).subjects;
}

// ---------------------------------------------------------------------------
// What gets printed
// ---------------------------------------------------------------------------

const show = (value: string | number | null) => (value === null ? "(none)" : String(value));

function describeChange(change: SubjectChange): string {
  return (
    `  recorded   subject_changes #${change.seq} ${change.id} at ${change.ts} by ${change.actor}: ` +
    `${change.action} ${change.user_id}, role ${show(change.role_before)} -> ${show(change.role_after)}, ` +
    `clearance ${show(change.clearance_before)} -> ${show(change.clearance_after)}`
  );
}

function describeGeneratedPassword(email: string, password: string): string {
  return (
    `  password   ${password}\n` +
    `             shown once: only its hash is stored, so it cannot be printed again. Give it to ${email}.`
  );
}

/**
 * The Arcade invite, for a user who can see the approval request tool. Asked of
 * the policy engine for this very subject, so a policy that hides the tool from
 * a role stops the reminder for that role without this script changing.
 */
function inviteReminder(governance: Database, subject: NewSubject): string | null {
  const tool = { toolkit: config.approvalsToolkit, name: REQUEST_TOOL };
  if (hiddenFrom(governance, subject, tool)) return null;
  return (
    `  arcade     ${subject.user_id} can request approvals, and requests go through Arcade's Slack provider, ` +
    `which only lets members of your Arcade project through.\n` +
    `             Before they request one, invite them: ${ARCADE_INVITE_WHERE}: invite ${subject.user_id}`
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Refuses a role the policy does not know, naming the ones it does. */
function checkRole(governance: Database, role: string): void {
  const roles = knownRoles(governance, fixtureCast().map((subject) => subject.role));
  if (!roles.includes(role)) {
    throw new Refusal(`role "${role}" is not one the policy knows: ${roles.join(", ")}`);
  }
}

/**
 * Whether a role's clearance defaults to 0: `/access` hides the approval tool
 * from it, so there is no approval for a clearance to cap.
 */
function impliesNoClearance(governance: Database, role: string): boolean {
  return hiddenFrom(
    governance,
    { user_id: "role-probe@users.invalid", display_name: "", role, clearance: 0 },
    { toolkit: config.loanToolkit, name: APPROVE_TOOL },
  );
}

/** Refuses an address either half already holds, naming which. */
function checkAbsent(identity: People, governance: Database, email: string): void {
  const person = identity.find(email) !== null;
  const subject = readSubject(governance, email) !== null;
  if (person && subject) throw new Refusal(`${email} already exists; change them with set-role or set-clearance`);
  if (person || subject) {
    throw new Refusal(
      `${email} is half there: ${person ? "an identity in idp.db but no subject" : "a subject in governance.db but no identity"}. ` +
        `Run \`bun run users remove ${email}\` and add them again`,
    );
  }
}

/**
 * Both halves or neither. Called after every check has passed; the only way
 * left to fail is the write itself, and then the identity is taken back out.
 */
async function createUser(
  identity: People,
  governance: Database,
  subject: NewSubject,
  password: string,
): Promise<SubjectChange> {
  await identity.add({ name: subject.display_name, email: subject.user_id, password });
  try {
    return addSubject(governance, subject, actor);
  } catch (cause) {
    identity.remove(subject.user_id);
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Refusal(`${subject.user_id}: the subject could not be written (${why}), so the identity was removed again and nothing was added`);
  }
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      role: { type: "string" },
      clearance: { type: "string" },
      password: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new UsageError("add takes one email");
  const email = parseEmail(positionals[0]);
  const name = values.name?.trim();
  if (!name) throw new UsageError("--name is required");
  const role = values.role?.trim();
  if (!role) throw new UsageError("--role is required: every user gets one, and a user without one is not added");
  const clearanceGiven = values.clearance === undefined ? undefined : parseClearance(values.clearance);
  const password = parsePassword(values.password);

  const governance = openControlPlane();
  try {
    checkRole(governance, role);
    let clearance = clearanceGiven;
    if (clearance === undefined) {
      if (!impliesNoClearance(governance, role)) {
        throw new UsageError(`--clearance is required for role ${role}`);
      }
      clearance = 0;
    }
    const subject: NewSubject = { user_id: email, display_name: name, role, clearance };

    const identity = await openIdentity();
    try {
      checkAbsent(identity, governance, email);
      const secret = password ?? generatePassword();
      const change = await createUser(identity, governance, subject, secret);

      console.log(`added ${email}: ${name}, role ${role}, clearance ${clearance}`);
      console.log(describeChange(change));
      if (password === undefined) console.log(describeGeneratedPassword(email, secret));
      const reminder = inviteReminder(governance, subject);
      if (reminder) console.log(reminder);
    } finally {
      identity.close();
    }
  } finally {
    governance.close();
  }
}

async function list(args: string[]): Promise<void> {
  if (args.length > 0) throw new UsageError("list takes no arguments");
  const governance = openControlPlane();
  const identity = await openIdentity();
  try {
    const people = new Map(identity.list().map((person) => [person.email.toLowerCase(), person]));
    const subjects = new Map(listSubjects(governance).map((subject) => [subjectId(subject.user_id), subject]));
    const emails = [...new Set([...people.keys(), ...subjects.keys()])].sort();
    if (emails.length === 0) {
      console.log("no users. Add one with `bun run users add`.");
      return;
    }

    const rows = emails.map((email) => {
      const person = people.get(email);
      const subject = subjects.get(email);
      const note =
        person && !subject
          ? "can sign in, but has no subject: denied at every hook"
          : subject && !person
            ? "has a subject, but no identity: cannot sign in"
            : "";
      return [
        email,
        person?.name ?? subject?.display_name ?? "",
        subject?.role ?? "-",
        subject ? String(subject.clearance) : "-",
        person ? "yes" : "no",
        subject ? "yes" : "no",
        note,
      ];
    });
    const header = ["EMAIL", "NAME", "ROLE", "CLEARANCE", "SIGN-IN", "SUBJECT", ""];
    const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column]!.length)));
    for (const row of [header, ...rows]) {
      console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
    }
  } finally {
    identity.close();
    governance.close();
  }
}

async function setRole(args: string[]): Promise<void> {
  if (args.length !== 2) throw new UsageError("set-role takes an email and a role");
  const email = parseEmail(args[0]);
  const role = args[1]!.trim();
  const governance = openControlPlane();
  try {
    checkRole(governance, role);
    const change = setSubjectRole(governance, email, role, actor);
    if (change === null) console.log(`${email} already has role ${role}; nothing changed, nothing recorded`);
    else {
      console.log(`${email}: role ${change.role_before} -> ${change.role_after}`);
      console.log(describeChange(change));
    }
  } catch (cause) {
    if (cause instanceof NoSuchSubjectError) throw new Refusal(`${email} has no subject; add them first`);
    throw cause;
  } finally {
    governance.close();
  }
}

async function setClearance(args: string[]): Promise<void> {
  if (args.length !== 2) throw new UsageError("set-clearance takes an email and a clearance");
  const email = parseEmail(args[0]);
  const clearance = parseClearance(args[1]!);
  const governance = openControlPlane();
  try {
    const change = setSubjectClearance(governance, email, clearance, actor);
    if (change === null) console.log(`${email} already has clearance ${clearance}; nothing changed, nothing recorded`);
    else {
      console.log(`${email}: clearance ${change.clearance_before} -> ${change.clearance_after}`);
      console.log(describeChange(change));
    }
  } catch (cause) {
    if (cause instanceof NoSuchSubjectError) throw new Refusal(`${email} has no subject; add them first`);
    throw cause;
  } finally {
    governance.close();
  }
}

async function remove(args: string[]): Promise<void> {
  if (args.length !== 1) throw new UsageError("remove takes one email");
  const email = parseEmail(args[0]);
  const governance = openControlPlane();
  const identity = await openIdentity();
  try {
    // The subject first: from this commit on, every hook denies them.
    const change = removeSubject(governance, email, actor);
    const removal = identity.remove(email);
    if (change === null && removal === null) throw new Refusal(`there is no user ${email}`);

    console.log(`removed ${email}`);
    if (change) console.log(describeChange(change));
    else console.log("  subject    none in governance.db");
    if (removal) {
      console.log(
        `  identity   removed from idp.db, with ${removal.sessions} session(s), ${removal.accessTokens} access token(s), ` +
          `${removal.refreshTokens} refresh token(s) and ${removal.consents} consent(s) revoked`,
      );
    } else console.log("  identity   none in idp.db");
  } finally {
    identity.close();
    governance.close();
  }
}

/** The four demo people, from the fixture's cast, with the flag each one's email comes from. */
function demoCast() {
  return fixtureCast().map((subject) => ({
    flag: subject.display_name.toLowerCase(),
    name: subject.display_name,
    role: subject.role,
    clearance: subject.clearance,
  }));
}

/** Lines from stdin, one per call; `null` once it ends. */
function stdinLines(): () => Promise<string | null> {
  const iterator = (console as unknown as AsyncIterable<string>)[Symbol.asyncIterator]();
  return async () => {
    const next = await iterator.next();
    return next.done ? null : next.value;
  };
}

async function seedDemo(args: string[]): Promise<void> {
  const cast = demoCast();
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      password: { type: "string" },
      ...Object.fromEntries(cast.map((person) => [person.flag, { type: "string" as const }])),
    },
  });
  if (positionals.length > 0) throw new UsageError("seed-demo takes flags only");
  const flags = values as Record<string, string | undefined>;
  const password = parsePassword(flags.password);

  // Every email before anything is opened: from its flag, or asked for.
  const emails = new Map<string, string>();
  let readLine: (() => Promise<string | null>) | null = null;
  for (const person of cast) {
    let raw = flags[person.flag];
    if (raw === undefined) {
      readLine ??= stdinLines();
      process.stderr.write(`${person.name}'s email (${person.role}, clearance ${person.clearance}): `);
      raw = (await readLine())?.trim() ?? undefined;
      if (raw === undefined) {
        throw new UsageError(
          `seed-demo needs an email for each of the demo cast: pass ${cast.map((each) => `--${each.flag}`).join(", ")}, or answer the prompts`,
        );
      }
    }
    emails.set(person.flag, parseEmail(raw, `--${person.flag}`));
  }
  const distinct = new Set(emails.values());
  if (distinct.size !== cast.length) throw new UsageError("seed-demo needs a different email for each person");

  const governance = openControlPlane();
  const identity = await openIdentity();
  const problems: string[] = [];
  try {
    for (const person of cast) {
      const email = emails.get(person.flag)!;
      const subject: NewSubject = { user_id: email, display_name: person.name, role: person.role, clearance: person.clearance };
      const hasPerson = identity.find(email) !== null;
      const existing = readSubject(governance, email);

      if (hasPerson && existing) {
        const differs = existing.role !== person.role || existing.clearance !== person.clearance;
        console.log(
          `${person.name}: ${email} already present, role ${existing.role}, clearance ${existing.clearance}` +
            (differs ? ` (the demo's is ${person.role}, ${person.clearance}; left as it is)` : ""),
        );
      } else if (hasPerson || existing) {
        problems.push(
          `${person.name}: ${email} is half there (${hasPerson ? "an identity but no subject" : "a subject but no identity"}); ` +
            `run \`bun run users remove ${email}\` and seed again`,
        );
        continue;
      } else {
        checkRole(governance, person.role);
        const secret = password ?? generatePassword();
        const change = await createUser(identity, governance, subject, secret);
        console.log(`${person.name}: added ${email}, role ${person.role}, clearance ${person.clearance}`);
        console.log(describeChange(change));
        if (password === undefined) console.log(describeGeneratedPassword(email, secret));
      }
      const reminder = inviteReminder(governance, readSubject(governance, email) ?? subject);
      if (reminder) console.log(reminder);
    }
  } finally {
    identity.close();
    governance.close();
  }
  if (problems.length > 0) throw new Refusal(problems.join("\n"));
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  add,
  list,
  "set-role": setRole,
  "set-clearance": setClearance,
  remove,
  "seed-demo": seedDemo,
};

const [command, ...rest] = process.argv.slice(2);
const run = command === undefined ? undefined : COMMANDS[command];

if (run === undefined) {
  console.error(command === undefined || command === "--help" ? USAGE : `unknown command "${command}"\n\n${USAGE}`);
  process.exit(command === "--help" ? 0 : 2);
}

try {
  await run(rest);
} catch (cause) {
  if (cause instanceof UsageError || (cause instanceof Error && "code" in cause && String(cause.code).startsWith("ERR_PARSE_ARGS"))) {
    console.error(`users ${command}: ${cause.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cause instanceof Refusal) {
    console.error(`users ${command}: ${cause.message}`);
    process.exit(1);
  }
  throw cause;
}
