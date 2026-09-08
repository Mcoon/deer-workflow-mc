import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runTracedCommand } from "@deerwork-ai/deer-workflow/trace";

import type {
  AppRegressionManifest,
  Bounds,
  CaseValidation,
  ControlBinding,
  DeviceProfile,
  DeviceProfileCollection,
  NormalizedPoint,
  RegressionAction,
  RegressionAssertion,
  RegressionCaseSet,
  UiControl,
  UiControlCollection,
  UiElement,
  UiPage,
  UiSelector,
  UiTransitionCollection,
} from "./types";

export {
  buildNavigationGraph,
  buildPageIndex,
  compileNavigationPlanActions,
  isNavigationStatus,
  planNavigation,
  resolvePageReference,
} from "./navigation";
export type { PageResolution } from "./navigation";

export const DEFAULT_ARTIFACT_ROOT = join(homedir(), ".ios_pref_optimizer");
export const DEFAULT_ASSET_ROOT =
  "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression";
export const DEFAULT_MOBILECLI_PREFLIGHT =
  "/Users/bytedance/.codex/skills/mobilecli/scripts/preflight.py";

const JSON_INDENT = 2;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface AssetLayout {
  readonly assetRoot: string;
  readonly appRoot: string;
  readonly manifestPath: string;
  readonly pagesDirectory: string;
  readonly controlsPath: string;
  readonly transitionsPath: string;
  readonly deviceProfilesPath: string;
  readonly navigationPolicyPath: string;
  readonly graphPath: string;
  readonly pageIndexPath: string;
  readonly mapHtmlPath: string;
  readonly casesDirectory: string;
  readonly compiledDirectory: string;
  readonly baselinesDirectory: string;
}

export function assetLayout(
  bundleId: string,
  assetRoot = DEFAULT_ASSET_ROOT,
): AssetLayout {
  const appRoot = join(resolve(assetRoot), safeSegment(bundleId));
  return {
    assetRoot: resolve(assetRoot),
    appRoot,
    manifestPath: join(appRoot, "manifest.json"),
    pagesDirectory: join(appRoot, "ui-map", "pages"),
    controlsPath: join(appRoot, "ui-map", "controls.json"),
    transitionsPath: join(appRoot, "ui-map", "transitions.json"),
    deviceProfilesPath: join(appRoot, "ui-map", "device-profiles.json"),
    navigationPolicyPath: join(appRoot, "ui-map", "navigation-policy.json"),
    graphPath: join(appRoot, "ui-map", "graph.json"),
    pageIndexPath: join(appRoot, "ui-map", "page-index.json"),
    mapHtmlPath: join(appRoot, "ui-map", "map.html"),
    casesDirectory: join(appRoot, "cases"),
    compiledDirectory: join(appRoot, "compiled"),
    baselinesDirectory: join(appRoot, "baselines"),
  };
}

export async function ensureAssetLayout(options: {
  bundleId: string;
  assetRoot?: string;
  appName?: string;
}): Promise<{ layout: AssetLayout; manifest: AppRegressionManifest }> {
  const layout = assetLayout(options.bundleId, options.assetRoot);
  await Promise.all([
    mkdir(layout.pagesDirectory, { recursive: true }),
    mkdir(layout.casesDirectory, { recursive: true }),
    mkdir(layout.compiledDirectory, { recursive: true }),
    mkdir(layout.baselinesDirectory, { recursive: true }),
  ]);

  const now = new Date().toISOString();
  const previous = await readJsonIfExists<AppRegressionManifest>(
    layout.manifestPath,
  );
  const manifest: AppRegressionManifest = {
    schemaVersion: "ios-app-regression-manifest/v1",
    bundleId: options.bundleId,
    appName: options.appName?.trim() || previous?.appName,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    uiMap: {
      pagesDirectory: relative(layout.appRoot, layout.pagesDirectory),
      controlsPath: relative(layout.appRoot, layout.controlsPath),
      transitionsPath: relative(layout.appRoot, layout.transitionsPath),
      deviceProfilesPath: relative(layout.appRoot, layout.deviceProfilesPath),
      navigationPolicyPath: relative(
        layout.appRoot,
        layout.navigationPolicyPath,
      ),
      graphPath: relative(layout.appRoot, layout.graphPath),
      pageIndexPath: relative(layout.appRoot, layout.pageIndexPath),
      mapHtmlPath: relative(layout.appRoot, layout.mapHtmlPath),
    },
    casesDirectory: relative(layout.appRoot, layout.casesDirectory),
    compiledDirectory: relative(layout.appRoot, layout.compiledDirectory),
    baselinesDirectory: relative(layout.appRoot, layout.baselinesDirectory),
  };
  await writeJsonAtomic(layout.manifestPath, manifest);

  await ensureCollection<UiControlCollection>(layout.controlsPath, {
    schemaVersion: "ios-ui-controls/v1",
    bundleId: options.bundleId,
    updatedAt: now,
    controls: [],
  });
  await ensureCollection<UiTransitionCollection>(layout.transitionsPath, {
    schemaVersion: "ios-ui-transitions/v1",
    bundleId: options.bundleId,
    updatedAt: now,
    transitions: [],
  });
  await ensureCollection<DeviceProfileCollection>(layout.deviceProfilesPath, {
    schemaVersion: "ios-device-profiles/v1",
    bundleId: options.bundleId,
    updatedAt: now,
    profiles: [],
  });

  return { layout, manifest };
}

export async function runCommand(
  command: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  return runTracedCommand(command, cwd);
}

export function buildMobilecliPreflightCommand(
  preflightPath = DEFAULT_MOBILECLI_PREFLIGHT,
): string[] {
  return ["python3", resolve(preflightPath)];
}

export function buildMobilecliScreenshotCommand(
  udid: string,
  outputPath: string,
): string[] {
  return ["mobilecli", "screenshot", "--device", udid, "-o", outputPath];
}

export function buildMobilecliUiDumpCommand(udid: string): string[] {
  return ["mobilecli", "dump", "ui", "--device", udid];
}

export function buildMobilecliForegroundCommand(udid: string): string[] {
  return ["mobilecli", "apps", "foreground", "--device", udid];
}

export function buildMobilecliDeviceInfoCommand(udid: string): string[] {
  return ["mobilecli", "device", "info", "--device", udid];
}

export function buildMobilecliActionCommand(options: {
  action: Exclude<RegressionAction, { type: "snapshot" }>;
  udid: string;
  bundleId: string;
  tapPoint?: { x: number; y: number };
}): string[] {
  const { action, udid } = options;
  switch (action.type) {
    case "launch_app":
      return [
        "mobilecli",
        "apps",
        "launch",
        "--device",
        udid,
        action.bundleId ?? options.bundleId,
      ];
    case "terminate_app":
      return [
        "mobilecli",
        "apps",
        "terminate",
        "--device",
        udid,
        action.bundleId ?? options.bundleId,
      ];
    case "tap": {
      if (!options.tapPoint) {
        throw new TypeError(
          `Tap action ${action.actionId} has no resolved point.`,
        );
      }
      return [
        "mobilecli",
        "io",
        "tap",
        "--device",
        udid,
        `${Math.round(options.tapPoint.x)},${Math.round(options.tapPoint.y)}`,
      ];
    }
    case "type_text":
      return ["mobilecli", "io", "text", "--device", udid, action.text];
    case "swipe":
      return [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        udid,
        `${action.from.x},${action.from.y},${action.to.x},${action.to.y}`,
      ];
    case "button":
      return ["mobilecli", "io", "button", "--device", udid, action.button];
    case "wait":
      return ["sleep", formatSeconds(action.durationMs)];
    case "navigate":
      throw new TypeError(
        `Navigate action ${action.actionId} must be expanded before device execution.`,
      );
  }
}

export function parseUiDump(input: string): UiElement[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    const elements: UiElement[] = [];
    visitUiNode(value, elements);
    return dedupeElements(elements);
  } catch {
    return parseXmlLikeUiDump(trimmed);
  }
}

export function matchUiElement(
  elements: readonly UiElement[],
  selector: UiSelector,
): UiElement | null {
  const scored = elements
    .map((element) => ({
      element,
      score: selectorScore(element, selector),
    }))
    .filter((candidate) => candidate.score >= requiredSelectorScore(selector))
    .sort((left, right) => right.score - left.score);

  const first = scored[0];
  const second = scored[1];
  if (!first || (second && second.score === first.score)) {
    return null;
  }
  return first.element;
}

export function centerOfBounds(bounds: Bounds): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

export function normalizePoint(
  point: { x: number; y: number },
  profile: Pick<DeviceProfile, "viewportWidth" | "viewportHeight">,
): NormalizedPoint {
  return {
    x: clamp(point.x / profile.viewportWidth),
    y: clamp(point.y / profile.viewportHeight),
  };
}

export function denormalizePoint(
  point: NormalizedPoint,
  profile: Pick<DeviceProfile, "viewportWidth" | "viewportHeight">,
): { x: number; y: number } {
  return {
    x: point.x * profile.viewportWidth,
    y: point.y * profile.viewportHeight,
  };
}

export function resolveTapPoint(options: {
  action: Extract<RegressionAction, { type: "tap" }>;
  controls: readonly UiControl[];
  elements: readonly UiElement[];
  profile: DeviceProfile;
  currentPageId?: string;
}): {
  point: { x: number; y: number } | null;
  source?: string;
  issue?: string;
} {
  if (
    options.currentPageId &&
    options.currentPageId !== options.action.pageId
  ) {
    return {
      point: null,
      issue: `Expected page ${options.action.pageId}, current page is ${options.currentPageId}.`,
    };
  }

  const controlId = options.action.target.controlId;
  if (controlId) {
    const control = options.controls.find(
      (candidate) =>
        candidate.controlId === controlId &&
        candidate.pageId === options.action.pageId,
    );
    if (!control) {
      return {
        point: null,
        issue: `Control ${controlId} is not defined on page ${options.action.pageId}.`,
      };
    }
    const matched = matchUiElement(options.elements, control.selector);
    if (matched?.bounds) {
      return { point: centerOfBounds(matched.bounds), source: "ui_dump" };
    }
    const binding = control.bindings.find(
      (candidate) => candidate.deviceProfileId === options.profile.profileId,
    );
    if (binding) {
      if (options.currentPageId !== options.action.pageId) {
        return {
          point: null,
          issue: `Control ${controlId} requires a verified ${options.action.pageId} page before using its coordinate binding.`,
        };
      }
      return {
        point: denormalizePoint(binding.normalizedPoint, options.profile),
        source: "device_binding",
      };
    }
    return {
      point: null,
      issue: `Control ${controlId} did not match the current UI dump and has no binding for ${options.profile.profileId}.`,
    };
  }

  if (options.action.target.point) {
    return { point: options.action.target.point, source: "explicit_point" };
  }
  if (options.action.target.normalizedPoint) {
    return {
      point: denormalizePoint(
        options.action.target.normalizedPoint,
        options.profile,
      ),
      source: "normalized_point",
    };
  }
  return {
    point: null,
    issue: `Tap action ${options.action.actionId} has no target.`,
  };
}

export function fingerprintUi(elements: readonly UiElement[]): string {
  const stable = elements
    .map((element) => ({
      accessibilityId: element.accessibilityId ?? "",
      label: element.label ?? "",
      role: element.role ?? "",
      text: element.text ?? "",
      value: element.value ?? "",
    }))
    .filter((element) => Object.values(element).some(Boolean))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 24);
}

export function validateCaseSet(
  caseSet: RegressionCaseSet,
  controls: readonly UiControl[],
  knownPageIds?: ReadonlySet<string>,
): CaseValidation {
  const issues: string[] = [];
  const caseIds = new Set<string>();
  const controlIds = new Set(controls.map((control) => control.controlId));

  for (const regressionCase of caseSet.cases) {
    if (caseIds.has(regressionCase.caseId)) {
      issues.push(`Duplicate caseId: ${regressionCase.caseId}.`);
    }
    caseIds.add(regressionCase.caseId);
    if (regressionCase.actions.length === 0) {
      issues.push(`Case ${regressionCase.caseId} has no actions.`);
    }

    const actionIds = new Set<string>();
    for (const action of regressionCase.actions) {
      if (actionIds.has(action.actionId)) {
        issues.push(
          `Case ${regressionCase.caseId} has duplicate actionId ${action.actionId}.`,
        );
      }
      actionIds.add(action.actionId);
      if (
        action.type === "tap" &&
        !action.target.controlId &&
        !action.target.point &&
        !action.target.normalizedPoint
      ) {
        issues.push(
          `Tap ${regressionCase.caseId}/${action.actionId} has no structured target.`,
        );
      }
      if (
        action.type === "tap" &&
        action.target.controlId &&
        !controlIds.has(action.target.controlId)
      ) {
        issues.push(
          `Tap ${regressionCase.caseId}/${action.actionId} references unknown control ${action.target.controlId}.`,
        );
      }
      if (
        knownPageIds &&
        (action.type === "tap" || action.type === "snapshot") &&
        !knownPageIds.has(action.pageId)
      ) {
        issues.push(
          `Action ${regressionCase.caseId}/${action.actionId} references unknown page ${action.pageId}.`,
        );
      }
      if (
        action.type === "navigate" &&
        action.targetPageId &&
        knownPageIds &&
        !knownPageIds.has(action.targetPageId)
      ) {
        issues.push(
          `Navigate ${regressionCase.caseId}/${action.actionId} references unknown page ${action.targetPageId}.`,
        );
      }
      if (
        action.type === "navigate" &&
        !action.targetPageId &&
        !action.targetPage?.trim()
      ) {
        issues.push(
          `Navigate ${regressionCase.caseId}/${action.actionId} requires targetPageId or targetPage.`,
        );
      }
      if (
        action.type === "tap" &&
        !hasTapPageGuard(action, action.target.controlId)
      ) {
        issues.push(
          `Tap ${regressionCase.caseId}/${action.actionId} must verify page ${action.pageId} or its target control before execution.`,
        );
      }
      for (const assertion of [
        ...(action.assertBefore ?? []),
        ...(action.assertAfter ?? []),
      ]) {
        validateAssertion(
          assertion,
          controlIds,
          knownPageIds,
          issues,
          regressionCase.caseId,
        );
      }
    }
    for (const assertion of [
      ...regressionCase.preconditions,
      ...regressionCase.expected,
    ]) {
      validateAssertion(
        assertion,
        controlIds,
        knownPageIds,
        issues,
        regressionCase.caseId,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

function hasTapPageGuard(
  action: Extract<RegressionAction, { type: "tap" }>,
  controlId: string | undefined,
): boolean {
  return (action.assertBefore ?? []).some(
    (assertion) =>
      (assertion.type === "page" && assertion.pageId === action.pageId) ||
      (assertion.type === "control_visible" &&
        assertion.pageId === action.pageId &&
        assertion.controlId === controlId),
  );
}

export function makeControl(options: {
  controlId: string;
  pageId: string;
  title: string;
  selector: UiSelector;
  profile: DeviceProfile;
  element: UiElement;
  observedAt: string;
}): UiControl {
  const bindings: ControlBinding[] = [];
  if (options.element.bounds) {
    const point = centerOfBounds(options.element.bounds);
    bindings.push({
      deviceProfileId: options.profile.profileId,
      normalizedPoint: normalizePoint(point, options.profile),
      normalizedBounds: {
        ...normalizePoint(options.element.bounds, options.profile),
        width: options.element.bounds.width / options.profile.viewportWidth,
        height: options.element.bounds.height / options.profile.viewportHeight,
      },
      observedAt: options.observedAt,
      source: "ui_dump",
    });
  }
  return {
    schemaVersion: "ios-ui-control/v1",
    controlId: options.controlId,
    pageId: options.pageId,
    title: options.title,
    role: options.element.role,
    selector: options.selector,
    bindings,
    updatedAt: options.observedAt,
  };
}

export function mergeControls(
  existing: readonly UiControl[],
  incoming: readonly UiControl[],
): UiControl[] {
  const merged = new Map(
    existing.map((control) => [control.controlId, control]),
  );
  for (const control of incoming) {
    const previous = merged.get(control.controlId);
    merged.set(control.controlId, {
      ...previous,
      ...control,
      bindings: mergeBindings(previous?.bindings ?? [], control.bindings),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.controlId.localeCompare(right.controlId),
  );
}

export async function loadControls(
  controlsPath: string,
): Promise<UiControlCollection> {
  return (
    (await readJsonIfExists<UiControlCollection>(controlsPath)) ?? {
      schemaVersion: "ios-ui-controls/v1",
      bundleId: "",
      updatedAt: new Date().toISOString(),
      controls: [],
    }
  );
}

export async function loadDeviceProfiles(
  deviceProfilesPath: string,
): Promise<DeviceProfileCollection> {
  return (
    (await readJsonIfExists<DeviceProfileCollection>(deviceProfilesPath)) ?? {
      schemaVersion: "ios-device-profiles/v1",
      bundleId: "",
      updatedAt: new Date().toISOString(),
      profiles: [],
    }
  );
}

export async function loadPage(
  pagesDirectory: string,
  pageId: string,
): Promise<UiPage | null> {
  return readJsonIfExists<UiPage>(
    join(pagesDirectory, `${safeSegment(pageId)}.json`),
  );
}

export async function loadPages(pagesDirectory: string): Promise<UiPage[]> {
  try {
    const names = (await readdir(pagesDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    return await Promise.all(
      names.map((name) => readJson<UiPage>(join(pagesDirectory, name))),
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, JSON_INDENT)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function renderRegressionHtml(options: {
  title: string;
  subtitle: string;
  summary: readonly { label: string; value: string }[];
  rows: readonly {
    id: string;
    title: string;
    verdict: string;
    details: string;
    evidence?: string;
  }[];
}): string {
  const summary = options.summary
    .map(
      (item) =>
        `<div class="metric"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`,
    )
    .join("");
  const rows = options.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td>${escapeHtml(row.title)}</td>
        <td><span class="verdict ${escapeHtml(row.verdict)}">${escapeHtml(row.verdict)}</span></td>
        <td>${escapeHtml(row.details)}</td>
        <td>${row.evidence ? `<a href="${escapeHtml(row.evidence)}">open</a>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#18202a}
body{margin:0}main{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
h1{font-size:28px;margin:0 0 6px;letter-spacing:0}.subtitle{color:#5c6673;margin:0 0 22px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:22px}
.metric{background:#fff;border:1px solid #dfe3e8;border-radius:6px;padding:14px}.metric span{display:block;color:#697482;font-size:12px;margin-bottom:6px}.metric strong{font-size:21px}
.table-wrap{overflow:auto;background:#fff;border:1px solid #dfe3e8;border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:12px;border-bottom:1px solid #edf0f3;font-size:13px;vertical-align:top}th{background:#f8f9fb;color:#586270}tr:last-child td{border-bottom:0}
.verdict{font-weight:700}.pass{color:#12733d}.fail{color:#b42318}.blocked,.needs_review{color:#9a5b00}a{color:#165dba}code{font-size:12px}
</style>
</head>
<body><main>
<h1>${escapeHtml(options.title)}</h1>
<p class="subtitle">${escapeHtml(options.subtitle)}</p>
<section class="summary">${summary}</section>
<div class="table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>状态</th><th>详情</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table></div>
</main></body></html>`;
}

function visitUiNode(value: unknown, output: UiElement[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitUiNode(item, output);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }

  const element = uiElementFromObject(value);
  if (element) {
    output.push(element);
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      visitUiNode(child, output);
    }
  }
}

function uiElementFromObject(value: Record<string, unknown>): UiElement | null {
  const bounds = parseBounds(
    value.bounds ?? value.frame ?? value.rect ?? value.visibleBounds,
  );
  const element: UiElement = {
    role: textValue(
      value.role ?? value.type ?? value.class ?? value.elementType,
    ),
    accessibilityId: textValue(
      value.accessibilityId ?? value.identifier ?? value.name ?? value.id,
    ),
    label: textValue(value.label ?? value.title ?? value.contentDescription),
    text: textValue(value.text),
    value: textValue(value.value ?? value.placeholder),
    bounds,
  };
  return Object.values(element).some((item) => item !== undefined)
    ? element
    : null;
}

function parseBounds(value: unknown): Bounds | undefined {
  if (Array.isArray(value) && value.length >= 4) {
    const numbers = value.slice(0, 4).map(numberValue);
    if (numbers.every((item) => item !== undefined)) {
      return {
        x: numbers[0]!,
        y: numbers[1]!,
        width: numbers[2]!,
        height: numbers[3]!,
      };
    }
  }
  if (typeof value === "string") {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (numbers && numbers.length >= 4) {
      const [first, second, third, fourth] = numbers;
      if (
        first !== undefined &&
        second !== undefined &&
        third !== undefined &&
        fourth !== undefined
      ) {
        return {
          x: first,
          y: second,
          width: third,
          height: fourth,
        };
      }
    }
  }
  if (!isObject(value)) {
    return undefined;
  }
  const x = numberValue(value.x ?? value.left);
  const y = numberValue(value.y ?? value.top);
  const width = numberValue(
    value.width ??
      (numberValue(value.right) !== undefined && x !== undefined
        ? numberValue(value.right)! - x
        : undefined),
  );
  const height = numberValue(
    value.height ??
      (numberValue(value.bottom) !== undefined && y !== undefined
        ? numberValue(value.bottom)! - y
        : undefined),
  );
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function parseXmlLikeUiDump(input: string): UiElement[] {
  const elements: UiElement[] = [];
  for (const tag of input.matchAll(/<[^!?/][^>]*>/g)) {
    const source = tag[0];
    const attributes = Object.fromEntries(
      [...source.matchAll(/([A-Za-z_][\w:-]*)=(?:"([^"]*)"|'([^']*)')/g)].map(
        (match) => [match[1], match[2] ?? match[3] ?? ""],
      ),
    );
    const element = uiElementFromObject(attributes);
    if (element) {
      elements.push(element);
    }
  }
  return dedupeElements(elements);
}

function selectorScore(element: UiElement, selector: UiSelector): number {
  let score = 0;
  const selectorText = selector.text;
  const selectorTextContains = selector.textContains;
  if (
    selector.accessibilityId &&
    equalText(element.accessibilityId, selector.accessibilityId)
  ) {
    score += 12;
  }
  if (selector.label && equalText(element.label, selector.label)) {
    score += 8;
  }
  if (
    selectorText &&
    [element.text, element.label, element.value].some((value) =>
      equalText(value, selectorText),
    )
  ) {
    score += 8;
  }
  if (
    selectorTextContains &&
    [element.text, element.label, element.value].some((value) =>
      containsText(value, selectorTextContains),
    )
  ) {
    score += 5;
  }
  if (selector.value && equalText(element.value, selector.value)) {
    score += 4;
  }
  if (selector.role && equalText(element.role, selector.role)) {
    score += 3;
  }
  return score;
}

function requiredSelectorScore(selector: UiSelector): number {
  if (selector.accessibilityId) {
    return 12;
  }
  if (selector.label || selector.text) {
    return 8;
  }
  if (selector.textContains) {
    return 5;
  }
  if (selector.value) {
    return 4;
  }
  if (selector.role) {
    return 3;
  }
  return Number.POSITIVE_INFINITY;
}

function dedupeElements(elements: readonly UiElement[]): UiElement[] {
  const output = new Map<string, UiElement>();
  for (const element of elements) {
    const key = JSON.stringify(element);
    output.set(key, element);
  }
  return [...output.values()];
}

function mergeBindings(
  existing: readonly ControlBinding[],
  incoming: readonly ControlBinding[],
): ControlBinding[] {
  const merged = new Map(
    existing.map((binding) => [binding.deviceProfileId, binding]),
  );
  for (const binding of incoming) {
    merged.set(binding.deviceProfileId, binding);
  }
  return [...merged.values()].sort((left, right) =>
    left.deviceProfileId.localeCompare(right.deviceProfileId),
  );
}

function validateAssertion(
  assertion: RegressionAssertion,
  controlIds: ReadonlySet<string>,
  knownPageIds: ReadonlySet<string> | undefined,
  issues: string[],
  caseId: string,
): void {
  if (
    assertion.type === "control_visible" &&
    !controlIds.has(assertion.controlId)
  ) {
    issues.push(
      `Case ${caseId} assertion references unknown control ${assertion.controlId}.`,
    );
  }
  if (
    knownPageIds &&
    (assertion.type === "page" || assertion.type === "control_visible") &&
    !knownPageIds.has(assertion.pageId)
  ) {
    issues.push(
      `Case ${caseId} assertion references unknown page ${assertion.pageId}.`,
    );
  }
}

async function ensureCollection<T>(path: string, fallback: T): Promise<void> {
  if (!(await fileExists(path))) {
    await writeJsonAtomic(path, fallback);
  }
}

function formatSeconds(durationMs: number): string {
  return Math.max(0, durationMs / 1000)
    .toFixed(3)
    .replace(/0+$/g, "")
    .replace(/\.$/, "");
}

function safeSegment(value: string): string {
  return (
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "item"
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function equalText(left: string | undefined, right: string): boolean {
  return left?.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function containsText(left: string | undefined, right: string): boolean {
  return (
    left
      ?.trim()
      .toLocaleLowerCase()
      .includes(right.trim().toLocaleLowerCase()) ?? false
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
