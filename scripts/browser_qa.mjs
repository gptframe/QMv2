import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const output = path.resolve(process.env.QA_OUTPUT || "qa-output");
const evidenceOutput = path.resolve("asset-lab/final-cinematic-production/evidence");
const viewportFilter = process.env.QA_VIEWPORT;
const mimeTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const viewports = [
  ["desktop-1920", 1920, 1080],
  ["desktop-1440", 1440, 900],
  ["desktop-1024", 1024, 768],
  ["tablet-820", 820, 1180],
  ["boundary-780", 780, 900],
  ["tablet-768", 768, 1024],
  ["mobile-430", 430, 932],
  ["mobile-390", 390, 844],
  ["mobile-375", 375, 812],
].filter(([name]) => !viewportFilter || name === viewportFilter);

const report = [];
const assertions = [];
const failures = [];

function check(condition, name, detail = "") {
  const result = { name, passed: Boolean(condition), detail };
  assertions.push(result);
  if (!result.passed) failures.push(result);
}

function observePage(page) {
  const events = { consoleErrors: [], pageErrors: [], failedRequests: [], sequenceRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error") events.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => events.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    events.failedRequests.push(`${request.url()} :: ${request.failure()?.errorText || "unknown failure"}`);
  });
  page.on("request", (request) => {
    if (/\/assets\/cinematic\/machining\/(?:1536|960)\/frame-\d{2}\.avif(?:\?|$)/.test(request.url())) {
      events.sequenceRequests.push(request.url());
    }
  });
  return events;
}

async function monitorLayoutStability(page) {
  await page.addInitScript(() => {
    window.__qaLayoutShift = 0;
    if (!window.PerformanceObserver?.supportedEntryTypes?.includes("layout-shift")) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__qaLayoutShift += entry.value;
      }
    });
    observer.observe({ type: "layout-shift", buffered: true });
  });
}

async function startStaticServer() {
  const rootWithSeparator = `${path.resolve(repositoryRoot)}${path.sep}`.toLowerCase();
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(repositoryRoot, relativePath);
      const normalizedPath = filePath.toLowerCase();

      if (normalizedPath !== path.resolve(repositoryRoot).toLowerCase() && !normalizedPath.startsWith(rootWithSeparator)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(error?.code === "ENOENT" ? "Not found" : "Server error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function waitForAllImages(page, { pollForCompletion = true } = {}) {
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach((image) => { image.loading = "eager"; });
  });
  const dimensions = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    step: Math.max(320, Math.floor(innerHeight * 0.75)),
  }));
  for (let top = 0; top < dimensions.height; top += dimensions.step) {
    await page.evaluate((position) => scrollTo(0, position), top);
    await page.waitForTimeout(24);
  }
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(120);
  if (pollForCompletion) {
    await page.waitForFunction(
      () => [...document.images].every((image) => image.complete),
      undefined,
      { timeout: 5000 },
    ).catch(() => {});
  } else {
    await page.waitForTimeout(750);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(150);
}

async function verifyDeclaredImageAssets(page) {
  const imageUrls = await page.evaluate(() => {
    const urls = [...document.querySelectorAll("img[src]")].map((image) => image.src);
    document.querySelectorAll("source[srcset]").forEach((source) => {
      source.srcset.split(",").forEach((candidate) => {
        const asset = candidate.trim().split(/\s+/)[0];
        if (asset) urls.push(new URL(asset, document.baseURI).href);
      });
    });
    return [...new Set(urls)];
  });
  const failures = [];
  for (const imageUrl of imageUrls) {
    try {
      const response = await page.request.get(imageUrl);
      const contentType = response.headers()["content-type"] || "";
      if (!response.ok() || !contentType.startsWith("image/")) {
        failures.push(`${imageUrl} (${response.status()} ${contentType || "no content type"})`);
      }
    } catch (error) {
      failures.push(`${imageUrl} (${error.message})`);
    }
  }
  return failures;
}

async function inspectPage(page, options) {
  await waitForAllImages(page, options);
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const anchors = [...document.querySelectorAll('a[href^="#"]')]
      .map((link) => link.getAttribute("href"))
      .filter((href) => href && href.length > 1);
    const missingAnchors = [...new Set(anchors)].filter((href) => {
      try {
        return !document.getElementById(decodeURIComponent(href.slice(1)));
      } catch {
        return true;
      }
    });
    const interactiveSelector = [
      "a[href]",
      "area[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "iframe",
      "audio[controls]",
      "video[controls]",
      "summary",
      "[contenteditable]:not([contenteditable=false])",
      "[tabindex]",
    ].join(",");
    const hiddenInteractive = [...document.querySelectorAll('[aria-hidden="true"]')]
      .flatMap((container) => [...container.querySelectorAll(interactiveSelector)])
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("href") ? `[href="${element.getAttribute("href")}"]` : ""}`);
    const images = [...document.images];
    const fallback = document.querySelector(".process-fallback");
    const fallbackItems = [...document.querySelectorAll(".process-fallback > li")];
    const h1 = document.querySelector("h1");
    const primaryCta = document.querySelector(".hero .button-primary");
    const resources = performance.getEntriesByType("resource");
    const sequenceCanvas = document.querySelector("[data-machining-sequence]");
    const sequenceFallback = document.querySelector("[data-machining-fallback]");

    return {
      title: document.title,
      h1Visible: visible(h1),
      primaryCtaVisible: visible(primaryCta) && primaryCta.getBoundingClientRect().width >= 44 && primaryCta.getBoundingClientRect().height >= 44,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      missingAnchors,
      brokenImages: images.filter((image) => visible(image) && (!image.complete || image.naturalWidth === 0)).map((image) => image.currentSrc || image.src),
      hiddenInteractive,
      gsapAvailable: Boolean(window.gsap),
      scrollTriggerAvailable: Boolean(window.ScrollTrigger),
      motionReady: document.documentElement.classList.contains("motion-ready"),
      cinematicReady: document.documentElement.classList.contains("process-cinematic-ready"),
      mobileJourneyReady: document.documentElement.classList.contains("process-mobile-ready"),
      processPinDisplay: getComputedStyle(document.querySelector("[data-process-pin]")).display,
      fallbackDisplay: getComputedStyle(fallback).display,
      fallbackVisible: visible(fallback),
      fallbackItems: fallbackItems.length,
      visibleFallbackItems: fallbackItems.filter(visible).length,
      mobileStageCount: document.querySelectorAll("[data-mobile-stage]").length,
      animatedMobileStages: document.querySelectorAll('[data-mobile-stage-state="animated"]').length,
      cumulativeLayoutShift: Number(window.__qaLayoutShift || 0),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      displayFontFamily: getComputedStyle(document.querySelector(".brand")).fontFamily,
      loadedResources: resources.length,
      encodedResourceBytes: Math.round(resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0)),
      sequence: sequenceCanvas ? {
        tier: sequenceCanvas.dataset.sequenceTier || "",
        status: sequenceCanvas.dataset.sequenceStatus || "",
        requestedFrame: sequenceCanvas.dataset.requestedFrame || "",
        renderedFrame: sequenceCanvas.dataset.sequenceFrame || "",
        loadedFrames: sequenceCanvas.dataset.loadedFrames || "",
        fallbackOpacity: sequenceFallback ? getComputedStyle(sequenceFallback).opacity : "",
        sceneReady: Boolean(sequenceCanvas.closest("[data-process-scene]")?.classList.contains("is-sequence-ready")),
      } : null,
    };
  });
}

async function setCinematicTime(page, timelineTime) {
  await page.evaluate((time) => {
    const trigger = window.ScrollTrigger?.getAll().find((candidate) => candidate.trigger?.matches?.("[data-process-scroll]"));
    if (!trigger) throw new Error("Manufacturing ScrollTrigger was not found");
    const journeyDuration = 7.8;
    scrollTo(0, trigger.start + (trigger.end - trigger.start) * (time / journeyDuration));
  }, timelineTime);
  await page.waitForTimeout(1200);
}

async function exerciseMobileJourney(page, { name, screenshotStages = [] }) {
  const initial = await page.evaluate(() => {
    const sample = document.querySelector('[data-mobile-stage="3"]');
    const media = sample?.querySelector("picture");
    const copy = sample?.querySelector(":scope > div");
    const mobileTriggers = window.ScrollTrigger?.getAll().filter((trigger) => trigger.trigger?.matches?.("[data-mobile-stage]")) || [];
    return {
      scrollY,
      ready: document.documentElement.classList.contains("process-mobile-ready"),
      cinematic: document.documentElement.classList.contains("process-cinematic-ready"),
      stageCount: document.querySelectorAll("[data-mobile-stage]").length,
      pinDisplay: getComputedStyle(document.querySelector("[data-process-pin]")).display,
      stageOpacity: sample ? Number(getComputedStyle(sample).opacity) : null,
      stageTransform: sample ? getComputedStyle(sample).transform : "",
      mediaOpacity: media ? Number(getComputedStyle(media).opacity) : null,
      mediaTransform: media ? getComputedStyle(media).transform : "",
      copyOpacity: copy ? Number(getComputedStyle(copy).opacity) : null,
      triggerCount: mobileTriggers.length,
      pinnedTriggerCount: mobileTriggers.filter((trigger) => Boolean(trigger.vars?.pin)).length,
    };
  });

  const stages = [];
  for (let index = 0; index < 8; index += 1) {
    const locator = page.locator(`[data-mobile-stage="${index}"]`);
    await locator.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (stageIndex) => document.querySelector(`[data-mobile-stage="${stageIndex}"]`)?.dataset.mobileStageState === "animated",
      index,
      { timeout: 5000 },
    );
    await page.waitForTimeout(80);
    const snapshot = await page.evaluate((stageIndex) => {
      const stage = document.querySelector(`[data-mobile-stage="${stageIndex}"]`);
      const picture = stage?.querySelector("picture");
      const image = stage?.querySelector("img");
      const copy = stage?.querySelector(":scope > div");
      const stageRect = stage?.getBoundingClientRect();
      const pictureRect = picture?.getBoundingClientRect();
      const copyRect = copy?.getBoundingClientRect();
      const overlapWidth = Math.max(0, Math.min(pictureRect?.right || 0, copyRect?.right || 0) - Math.max(pictureRect?.left || 0, copyRect?.left || 0));
      const overlapHeight = Math.max(0, Math.min(pictureRect?.bottom || 0, copyRect?.bottom || 0) - Math.max(pictureRect?.top || 0, copyRect?.top || 0));
      return {
        index: stageIndex,
        state: stage?.dataset.mobileStageState,
        active: stage?.classList.contains("is-mobile-active"),
        stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : 0,
        mediaOpacity: picture ? Number(getComputedStyle(picture).opacity) : 0,
        copyOpacity: copy ? Number(getComputedStyle(copy).opacity) : 0,
        mediaTransform: picture ? getComputedStyle(picture).transform : "",
        imageLoaded: Boolean(image?.complete && image.naturalWidth > 0),
        imageCurrentSrc: image?.currentSrc || "",
        withinViewportWidth: Boolean(stageRect && stageRect.left >= -1 && stageRect.right <= document.documentElement.clientWidth + 1),
        hasLayout: Boolean(stageRect && stageRect.width > 0 && stageRect.height > 120),
        contentOverlap: overlapWidth > 1 && overlapHeight > 1,
        scrollY,
      };
    }, index);
    stages.push(snapshot);
    if (screenshotStages.includes(index)) {
      await page.screenshot({ path: path.join(output, `${name}-mobile-stage-${index}.png`), fullPage: false });
    }
  }

  return {
    initial,
    stages,
    animatedCount: await page.locator('[data-mobile-stage-state="animated"]').count(),
    finalScrollY: await page.evaluate(() => scrollY),
    layoutShift: await page.evaluate(() => Number(window.__qaLayoutShift || 0)),
  };
}

async function exerciseContactMenu(page, { mobile, screenshotPath }) {
  const result = await page.evaluate(() => {
    const button = document.querySelector("[data-contact-button]");
    const panel = document.querySelector("[data-contact-menu]");
    const email = document.querySelector('[data-contact-method="email"]');
    const whatsapp = document.querySelector('[data-contact-method="whatsapp"]');
    return {
      hasPopup: button?.getAttribute("aria-haspopup"),
      controls: button?.getAttribute("aria-controls"),
      panelId: panel?.id,
      panelRole: panel?.getAttribute("role"),
      initialExpanded: button?.getAttribute("aria-expanded"),
      initialHidden: panel?.hidden,
      emailHref: email?.getAttribute("href"),
      whatsappHref: whatsapp?.getAttribute("href"),
      whatsappTarget: whatsapp?.getAttribute("target"),
      whatsappRel: whatsapp?.getAttribute("rel"),
    };
  });

  const openMobileNavigation = async () => {
    if (!mobile) return;
    if (await page.getAttribute("[data-menu-button]", "aria-expanded") !== "true") {
      await page.click("[data-menu-button]");
    }
  };

  await openMobileNavigation();
  await page.focus("[data-contact-button]");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  result.opened = await page.evaluate(() => ({
    expanded: document.querySelector("[data-contact-button]")?.getAttribute("aria-expanded"),
    hidden: document.querySelector("[data-contact-menu]")?.hidden,
  }));
  await page.keyboard.press("Tab");
  result.firstKeyboardItem = await page.evaluate(() => document.activeElement?.getAttribute("data-contact-method"));
  await page.keyboard.press("ArrowDown");
  result.secondKeyboardItem = await page.evaluate(() => document.activeElement?.getAttribute("data-contact-method"));
  await page.keyboard.press("Escape");
  result.escapeState = await page.evaluate(() => ({
    expanded: document.querySelector("[data-contact-button]")?.getAttribute("aria-expanded"),
    hidden: document.querySelector("[data-contact-menu]")?.hidden,
    focusReturned: document.activeElement?.hasAttribute("data-contact-button"),
  }));

  await page.evaluate(() => {
    window.__contactTestActivations = [];
    document.querySelectorAll("[data-contact-method]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        window.__contactTestActivations.push(link.getAttribute("data-contact-method"));
      }, { once: true });
    });
  });
  for (const method of ["email", "whatsapp"]) {
    await openMobileNavigation();
    await page.focus("[data-contact-button]");
    await page.keyboard.press("Enter");
    await page.click(`[data-contact-method="${method}"]`);
  }
  result.activations = await page.evaluate(() => window.__contactTestActivations);

  await openMobileNavigation();
  await page.focus("[data-contact-button]");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.evaluate(() => document.querySelector("main")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  result.outsideClickState = await page.evaluate(() => ({
    expanded: document.querySelector("[data-contact-button]")?.getAttribute("aria-expanded"),
    hidden: document.querySelector("[data-contact-menu]")?.hidden,
    mobileNavigationExpanded: document.querySelector("[data-menu-button]")?.getAttribute("aria-expanded"),
  }));

  return result;
}

function assertSharedState(name, state, events) {
  check(state.h1Visible, `${name}: main heading is visible`);
  check(state.primaryCtaVisible, `${name}: primary CTA meets the visible 44px target`);
  check(!state.horizontalOverflow, `${name}: no horizontal overflow`, `${state.scrollWidth}/${state.clientWidth}`);
  check(state.missingAnchors.length === 0, `${name}: all internal anchors resolve`, state.missingAnchors.join(", "));
  const imageFailures = [...state.brokenImages, ...state.imageAssetFailures];
  check(imageFailures.length === 0, `${name}: all visible and declared images load`, imageFailures.join(", "));
  check(state.hiddenInteractive.length === 0, `${name}: aria-hidden subtrees contain no interactive descendants`, state.hiddenInteractive.join(", "));
  check(events.consoleErrors.length === 0, `${name}: no console errors`, events.consoleErrors.join(" | "));
  check(events.pageErrors.length === 0, `${name}: no page errors`, events.pageErrors.join(" | "));
  check(events.failedRequests.length === 0, `${name}: no failed requests`, events.failedRequests.join(" | "));
}

await mkdir(output, { recursive: true });
await mkdir(evidenceOutput, { recursive: true });
const stylesSource = await readFile(path.join(repositoryRoot, "styles.css"), "utf8");
check(!/\b(?:Archivo|Inter)\b/i.test(stylesSource), "typography: no legacy Archivo or Inter declarations remain");
check(stylesSource.includes("--font-display:") && stylesSource.includes("--font-body:"), "typography: display and body tokens are defined");

let localServer;
let browser;
let safariBrowser;

try {
  const target = process.env.QA_URL ? { url: process.env.QA_URL } : await startStaticServer();
  localServer = target.server;
  browser = await chromium.launch({ headless: true });

  console.log("Running staged-loading performance probe...");
  const performanceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const performancePage = await performanceContext.newPage();
  const performanceEvents = observePage(performancePage);
  await performancePage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  await performancePage.waitForTimeout(350);
  const beforeManufacturing = await performancePage.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    return {
      resourceCount: resources.length,
      encodedBytes: Math.round(resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0)),
      urls: resources.map((item) => item.name),
    };
  });
  check(performanceEvents.sequenceRequests.length === 0, "loading: machining sequence is absent from initial page load", `${performanceEvents.sequenceRequests.length} requests`);
  await performancePage.evaluate(() => {
    const element = document.querySelector("[data-process-scroll]");
    scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * 0.65);
  });
  await performancePage.waitForFunction(
    () => document.querySelector("[data-machining-sequence]")?.dataset.sequenceStatus === "complete",
    undefined,
    { timeout: 30000 },
  );
  const afterActivation = await performancePage.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    const sequence = resources.filter((item) => item.name.includes("/assets/cinematic/machining/"));
    return {
      resourceCount: resources.length,
      encodedBytes: Math.round(resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0)),
      sequenceResourceCount: sequence.length,
      sequenceEncodedBytes: Math.round(sequence.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0)),
      sequenceTier: document.querySelector("[data-machining-sequence]")?.dataset.sequenceTier,
    };
  });
  check(afterActivation.sequenceResourceCount === 32, "loading: approach activation requests the complete 32-frame sequence", `${afterActivation.sequenceResourceCount}/32`);
  check(afterActivation.sequenceTier === "1536", "loading: 1440px desktop selects the 1536 tier", afterActivation.sequenceTier);
  const tierPayloads = {};
  for (const tier of ["1536", "960"]) {
    let bytes = 0;
    for (let index = 0; index < 32; index += 1) {
      bytes += (await stat(path.join(repositoryRoot, "assets", "cinematic", "machining", tier, `frame-${String(index).padStart(2, "0")}.avif`))).size;
    }
    tierPayloads[tier] = { frameCount: 32, bytes };
  }
  const runtimePerformance = {
    generatedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 900 },
    beforeManufacturing,
    afterActivation,
    activationDeltaBytes: afterActivation.encodedBytes - beforeManufacturing.encodedBytes,
    encodedSequencePayloads: tierPayloads,
    mobileSequencePayloadBytes: 0,
    note: "The mobile and reduced-motion assertions below verify that no machining-frame request is made.",
  };
  await writeFile(path.join(repositoryRoot, "asset-lab", "final-cinematic-production", "runtime-performance.json"), `${JSON.stringify(runtimePerformance, null, 2)}\n`, "utf8");
  report.push({ name: "staged-loading-performance", ...runtimePerformance, ...performanceEvents });
  await performanceContext.close();
  console.log("Completed staged-loading performance probe.");

  for (const [name, width, height] of viewports) {
    console.log(`Running ${name} (${width}x${height})...`);
    const touchViewport = width <= 1024;
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touchViewport,
      isMobile: width <= 430,
      deviceScaleFactor: touchViewport ? 2 : 1,
    });
    const page = await context.newPage();
    const events = observePage(page);
    await monitorLayoutStability(page);
    await page.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(250);
    const mobileJourney = width <= 1080
      ? await exerciseMobileJourney(page, {
        name,
        screenshotStages: name === "mobile-390" ? [0, 3, 7] : name === "tablet-820" ? [1, 4, 7] : [],
      })
      : null;
    const state = await inspectPage(page);
    state.mobileJourney = mobileJourney;
    state.imageAssetFailures = await verifyDeclaredImageAssets(page);

    check(state.gsapAvailable && state.scrollTriggerAvailable, `${name}: local GSAP and ScrollTrigger are available`);
    if (width > 1080) {
      check(state.cinematicReady, `${name}: manufacturing cinematic is active`);
      check(!state.mobileJourneyReady, `${name}: lightweight touch journey is inactive on desktop`);
      check(state.processPinDisplay !== "none", `${name}: cinematic pin is displayed`);
      check(!state.fallbackVisible, `${name}: stacked fallback is hidden while the cinematic is active`);
      await page.waitForFunction(
        () => document.querySelector("[data-machining-sequence]")?.dataset.sequenceStatus === "complete",
        undefined,
        { timeout: 30000 },
      );
      state.sequence = await page.evaluate(() => {
        const canvas = document.querySelector("[data-machining-sequence]");
        return { tier: canvas?.dataset.sequenceTier, status: canvas?.dataset.sequenceStatus, loadedFrames: canvas?.dataset.loadedFrames };
      });
      check(state.sequence.status === "complete" && state.sequence.loadedFrames === "32", `${name}: all machining frames load after activation`, JSON.stringify(state.sequence));
      check(state.sequence.tier === (width >= 1280 ? "1536" : "960"), `${name}: responsive sequence tier is correct`, JSON.stringify(state.sequence));
    } else {
      check(!state.cinematicReady && state.mobileJourneyReady, `${name}: lightweight touch journey replaces the pinned cinematic`);
      check(state.processPinDisplay === "none", `${name}: touch journey uses no pinned process panel`);
      check(state.fallbackVisible && state.fallbackItems === 8 && state.visibleFallbackItems === 8, `${name}: all eight animated stages remain visible and readable`, `${state.visibleFallbackItems}/${state.fallbackItems}`);
      check(
        mobileJourney.initial.ready && !mobileJourney.initial.cinematic && mobileJourney.initial.stageCount === 8 && mobileJourney.initial.triggerCount === 8 && mobileJourney.initial.pinnedTriggerCount === 0,
        `${name}: eight unpinned mobile ScrollTriggers initialise`,
        JSON.stringify(mobileJourney.initial),
      );
      check(
        mobileJourney.initial.stageOpacity < 1 && mobileJourney.initial.mediaOpacity < 1 && mobileJourney.initial.copyOpacity < 1,
        `${name}: mobile stages begin from a visible transitional state`,
        JSON.stringify(mobileJourney.initial),
      );
      check(
        mobileJourney.animatedCount === 8 && mobileJourney.stages.every((stage) => stage.state === "animated" && stage.stageOpacity === 1 && stage.mediaOpacity === 1 && stage.copyOpacity === 1),
        `${name}: all eight mobile stages complete their image and caption transitions`,
        JSON.stringify(mobileJourney.stages),
      );
      check(
        mobileJourney.stages.every((stage) => stage.imageLoaded && /-960\.(?:avif|webp)$/.test(stage.imageCurrentSrc)),
        `${name}: touch journey uses loaded 960px stage imagery`,
        JSON.stringify(mobileJourney.stages.map(({ index, imageLoaded, imageCurrentSrc }) => ({ index, imageLoaded, imageCurrentSrc }))),
      );
      check(
        mobileJourney.stages.every((stage) => stage.withinViewportWidth && stage.hasLayout && !stage.contentOverlap),
        `${name}: animated stages avoid overflow, collapse and content overlap`,
        JSON.stringify(mobileJourney.stages),
      );
      check(mobileJourney.finalScrollY > mobileJourney.initial.scrollY + height, `${name}: stage progression preserves natural document scrolling`, `${mobileJourney.initial.scrollY} -> ${mobileJourney.finalScrollY}`);
      check(mobileJourney.layoutShift < 0.1, `${name}: animated route avoids material layout shift`, String(mobileJourney.layoutShift));
      check(events.sequenceRequests.length === 0, `${name}: touch journey makes no machining-sequence requests`, `${events.sequenceRequests.length} requests`);
    }

    if (width <= 1080) {
      await page.focus("[data-menu-button]");
      await page.keyboard.press("Enter");
      const opened = await page.getAttribute("[data-menu-button]", "aria-expanded");
      await page.keyboard.press("Tab");
      const focusMovedIntoMenu = await page.evaluate(() => Boolean(document.activeElement?.closest("[data-menu]")));
      await page.keyboard.press("Escape");
      const closed = await page.getAttribute("[data-menu-button]", "aria-expanded");
      const focusReturned = await page.evaluate(() => document.activeElement?.hasAttribute("data-menu-button"));
      state.mobileMenuKeyboard = { opened, focusMovedIntoMenu, closed, focusReturned };
      check(opened === "true" && focusMovedIntoMenu && closed === "false" && focusReturned, `${name}: mobile menu works with keyboard only`, JSON.stringify(state.mobileMenuKeyboard));
    }

    if (name === "desktop-1440" || name === "mobile-390") {
      state.contactMenu = await exerciseContactMenu(page, {
        mobile: width <= 1080,
        screenshotPath: path.join(output, `${name}-contact-menu.png`),
      });
      const contact = state.contactMenu;
      check(
        contact.hasPopup === "menu" && contact.controls === contact.panelId && contact.panelRole === "menu" && contact.initialExpanded === "false" && contact.initialHidden,
        `${name}: contact disclosure has valid initial ARIA state`,
        JSON.stringify(contact),
      );
      check(
        contact.emailHref === "mailto:sales@quantamorph.co.uk?subject=Manufacturing%20enquiry%20-%20drawing%20submission",
        `${name}: email option targets the sales inbox with the manufacturing-enquiry subject`,
        contact.emailHref || "missing",
      );
      check(
        contact.whatsappHref?.startsWith("https://wa.me/447721131658?text=") && decodeURIComponent(contact.whatsappHref).includes("manufacturing enquiry") && contact.whatsappTarget === "_blank" && contact.whatsappRel?.includes("noopener"),
        `${name}: WhatsApp option targets the correct number with a professional prefilled message`,
        contact.whatsappHref || "missing",
      );
      check(
        contact.opened.expanded === "true" && !contact.opened.hidden && contact.firstKeyboardItem === "email" && contact.secondKeyboardItem === "whatsapp",
        `${name}: contact menu opens and supports keyboard item navigation`,
        JSON.stringify(contact),
      );
      check(
        contact.escapeState.expanded === "false" && contact.escapeState.hidden && contact.escapeState.focusReturned,
        `${name}: Escape closes the contact menu and restores focus`,
        JSON.stringify(contact.escapeState),
      );
      check(
        contact.activations.join(",") === "email,whatsapp",
        `${name}: both contact links can be activated`,
        contact.activations.join(","),
      );
      check(
        contact.outsideClickState.expanded === "false" && contact.outsideClickState.hidden && (!width || width > 1080 || contact.outsideClickState.mobileNavigationExpanded === "false"),
        `${name}: outside click dismisses the contact menu`,
        JSON.stringify(contact.outsideClickState),
      );
    }

    if (name === "desktop-1440") {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press("Tab");
      state.keyboardFocus = await page.evaluate(() => {
        const element = document.activeElement;
        const style = getComputedStyle(element);
        return { text: element?.textContent?.trim(), outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
      });
      check(state.keyboardFocus.outlineStyle !== "none" && state.keyboardFocus.outlineWidth !== "0px", `${name}: keyboard focus is visibly styled`, JSON.stringify(state.keyboardFocus));
      await page.evaluate(() => document.activeElement?.blur());

      await setCinematicTime(page, 2.60);
      const sequenceStart = await page.getAttribute("[data-machining-sequence]", "data-sequence-frame");
      check(sequenceStart === "0", `${name}: first machining frame is reachable`, sequenceStart || "missing");
      await page.screenshot({ path: path.join(evidenceOutput, "machining-sequence-begin.png"), fullPage: false });
      await setCinematicTime(page, 3.03);
      const sequenceMiddle = await page.getAttribute("[data-machining-sequence]", "data-sequence-frame");
      check(Number(sequenceMiddle) >= 10 && Number(sequenceMiddle) <= 21, `${name}: machining frame changes through the middle`, sequenceMiddle || "missing");
      await page.screenshot({ path: path.join(evidenceOutput, "machining-sequence-middle.png"), fullPage: false });
      await setCinematicTime(page, 3.46);
      const sequenceEnd = await page.getAttribute("[data-machining-sequence]", "data-sequence-frame");
      check(sequenceEnd === "31", `${name}: last machining frame is reachable`, sequenceEnd || "missing");
      await page.screenshot({ path: path.join(evidenceOutput, "machining-sequence-finished.png"), fullPage: false });
      await setCinematicTime(page, 5.15);
      state.processSample = await page.evaluate(() => ({
        readout: document.querySelector("[data-stage-readout]")?.textContent,
        activeStep: document.querySelector("[data-process-step].is-active")?.textContent.trim(),
        visibleScenes: [...document.querySelectorAll("[data-process-scene]")].filter((scene) => Number(getComputedStyle(scene).opacity) > 0.2).length,
        pinnedTop: Math.round(document.querySelector("[data-process-pin]").getBoundingClientRect().top),
      }));
      check(Boolean(state.processSample.readout && state.processSample.activeStep) && state.processSample.visibleScenes >= 1, `${name}: cinematic stage status advances`, JSON.stringify(state.processSample));
      await page.screenshot({ path: path.join(output, "desktop-1440-process.png"), fullPage: false });
      await page.screenshot({ path: path.join(evidenceOutput, "inspection-state.png"), fullPage: false });

      await page.locator("#capabilities").scrollIntoViewIfNeeded();
      await page.focus("#capability-tab-0");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(180);
      state.capabilityKeyboard = await page.evaluate(() => ({
        selected: document.querySelector('[data-capability][aria-selected="true"]')?.id,
        title: document.querySelector("[data-capability-title]")?.textContent,
        image: document.querySelector("[data-capability-image]")?.getAttribute("src"),
      }));
      check(state.capabilityKeyboard.selected === "capability-tab-1", `${name}: capability tabs respond to keyboard navigation`, JSON.stringify(state.capabilityKeyboard));
      await page.screenshot({ path: path.join(output, "desktop-1440-capabilities.png"), fullPage: false });
    }

    if (name === "mobile-390") {
      const stageTop = await page.evaluate(() => {
        const stage = document.querySelectorAll(".process-fallback > li")[3];
        return stage.getBoundingClientRect().top + scrollY;
      });
      await page.evaluate((top) => scrollTo(0, top - 68), stageTop);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(output, "mobile-390-process.png"), fullPage: false });
      await page.screenshot({ path: path.join(evidenceOutput, "mobile-stacked-route.png"), fullPage: false });
    }

    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(900);
    const screenshotPath = path.join(output, `${name}-hero.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    if (name === "desktop-1440") await page.screenshot({ path: path.join(evidenceOutput, "desktop-hero.png"), fullPage: false });

    assertSharedState(name, state, events);
    report.push({ name, width, height, ...state, ...events, screenshotPath });
    await context.close();
    console.log(`Completed ${name}.`);
  }

  console.log("Running reduced-motion...");
  const reducedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  const reducedEvents = observePage(reducedPage);
  await reducedPage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  const reduced = await inspectPage(reducedPage);
  reduced.imageAssetFailures = await verifyDeclaredImageAssets(reducedPage);
  check(!reduced.motionReady && !reduced.cinematicReady, "reduced-motion: cinematic enhancement is disabled");
  check(reduced.processPinDisplay === "none", "reduced-motion: cinematic pin is hidden");
  check(reduced.fallbackVisible && reduced.fallbackItems === 8 && reduced.visibleFallbackItems === 8, "reduced-motion: complete stacked route is visible", `${reduced.visibleFallbackItems}/${reduced.fallbackItems}`);
  check(reducedEvents.sequenceRequests.length === 0, "reduced-motion: no machining-sequence requests are made", `${reducedEvents.sequenceRequests.length} requests`);
  assertSharedState("reduced-motion", reduced, reducedEvents);
  report.push({ name: "reduced-motion", ...reduced, ...reducedEvents });
  await reducedContext.close();
  console.log("Completed reduced-motion.");

  console.log("Running no-javascript...");
  const noJsContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const noJsPage = await noJsContext.newPage();
  const noJsEvents = observePage(noJsPage);
  await noJsPage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  const noJs = await inspectPage(noJsPage, { pollForCompletion: false });
  noJs.imageAssetFailures = await verifyDeclaredImageAssets(noJsPage);
  check(!noJs.cinematicReady, "no-javascript: cinematic enhancement is inactive");
  check(noJs.processPinDisplay === "none", "no-javascript: cinematic pin is hidden");
  check(noJs.fallbackVisible && noJs.fallbackItems === 8 && noJs.visibleFallbackItems === 8, "no-javascript: complete eight-stage route is visible", `${noJs.visibleFallbackItems}/${noJs.fallbackItems}`);
  check(noJsEvents.sequenceRequests.length === 0, "no-javascript: no machining-sequence requests are made", `${noJsEvents.sequenceRequests.length} requests`);
  assertSharedState("no-javascript", noJs, noJsEvents);
  report.push({ name: "no-javascript", ...noJs, ...noJsEvents });
  await noJsContext.close();
  console.log("Completed no-javascript.");

  console.log("Running machining-sequence failure fallback...");
  const failureContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failurePage = await failureContext.newPage();
  await failurePage.route("**/assets/cinematic/machining/*/frame-00.avif", (route) => route.fulfill({ status: 503, contentType: "image/avif", body: "" }));
  await failurePage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  await failurePage.evaluate(() => {
    const element = document.querySelector("[data-process-scroll]");
    scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * 0.65);
  });
  await failurePage.waitForFunction(
    () => ["degraded", "complete"].includes(document.querySelector("[data-machining-sequence]")?.dataset.sequenceStatus),
    undefined,
    { timeout: 30000 },
  );
  await setCinematicTime(failurePage, 3.03);
  const failureFallback = await failurePage.evaluate(() => {
    const canvas = document.querySelector("[data-machining-sequence]");
    const picture = document.querySelector("[data-machining-fallback]");
    return {
      status: canvas?.dataset.sequenceStatus,
      loadedFrames: canvas?.dataset.loadedFrames,
      sceneReady: canvas?.closest("[data-process-scene]")?.classList.contains("is-sequence-ready"),
      fallbackOpacity: picture ? getComputedStyle(picture).opacity : "",
    };
  });
  check(failureFallback.status === "degraded" && failureFallback.loadedFrames === "31" && !failureFallback.sceneReady && failureFallback.fallbackOpacity === "1", "sequence failure: static rough fallback survives a failed first frame", JSON.stringify(failureFallback));
  report.push({ name: "sequence-failure-fallback", ...failureFallback });
  await failureContext.close();
  console.log("Completed machining-sequence failure fallback.");

  console.log("Running touch-scroll probe...");
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const touchPage = await touchContext.newPage();
  const touchEvents = observePage(touchPage);
  await touchPage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  const touchBefore = await touchPage.evaluate(() => ({
    scrollY,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    mobileJourneyReady: document.documentElement.classList.contains("process-mobile-ready"),
  }));
  const cdp = await touchContext.newCDPSession(touchPage);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 720, radiusX: 4, radiusY: 4 }] });
  for (const y of [630, 535, 440, 345, 250, 155]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y, radiusX: 4, radiusY: 4 }] });
    await touchPage.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touchPage.waitForTimeout(500);
  const touchAfter = await touchPage.evaluate(() => ({ scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight }));
  check(touchBefore.mobileJourneyReady && touchAfter.scrollY > touchBefore.scrollY + 80, "touch: vertical swipe preserves native page scrolling", JSON.stringify({ touchBefore, touchAfter }));
  check(touchBefore.touchAction !== "none", "touch: document does not disable native touch gestures", touchBefore.touchAction);
  check(touchEvents.sequenceRequests.length === 0, "touch: initial swipe does not request machining frames", `${touchEvents.sequenceRequests.length} requests`);
  check(touchEvents.consoleErrors.length === 0 && touchEvents.pageErrors.length === 0, "touch: no console or page errors", JSON.stringify(touchEvents));
  report.push({ name: "touch-scroll", touchBefore, touchAfter, ...touchEvents });
  await touchContext.close();
  console.log("Completed touch-scroll probe.");

  console.log("Running iPad orientation probe...");
  const orientationContext = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const orientationPage = await orientationContext.newPage();
  const orientationEvents = observePage(orientationPage);
  await monitorLayoutStability(orientationPage);
  await orientationPage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  await orientationPage.locator('[data-mobile-stage="2"]').scrollIntoViewIfNeeded();
  await orientationPage.waitForFunction(() => document.querySelector('[data-mobile-stage="2"]')?.dataset.mobileStageState === "animated", undefined, { timeout: 5000 });
  const portraitState = await orientationPage.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    mobileJourneyReady: document.documentElement.classList.contains("process-mobile-ready"),
    pinDisplay: getComputedStyle(document.querySelector("[data-process-pin]")).display,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  await orientationPage.setViewportSize({ width: 1180, height: 820 });
  await orientationPage.evaluate(() => dispatchEvent(new Event("orientationchange")));
  await orientationPage.waitForTimeout(500);
  await orientationPage.locator('[data-mobile-stage="5"]').scrollIntoViewIfNeeded();
  await orientationPage.waitForFunction(() => document.querySelector('[data-mobile-stage="5"]')?.dataset.mobileStageState === "animated", undefined, { timeout: 5000 });
  const landscapeState = await orientationPage.evaluate(() => {
    const stage = document.querySelector('[data-mobile-stage="5"]');
    const rect = stage.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      mobileJourneyReady: document.documentElement.classList.contains("process-mobile-ready"),
      pinDisplay: getComputedStyle(document.querySelector("[data-process-pin]")).display,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      stageState: stage.dataset.mobileStageState,
      stageWithinViewport: rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1,
      layoutShift: Number(window.__qaLayoutShift || 0),
    };
  });
  await orientationPage.screenshot({ path: path.join(output, "ipad-landscape-journey.png"), fullPage: false });
  check(portraitState.mobileJourneyReady && landscapeState.mobileJourneyReady, "orientation: lightweight journey survives iPad portrait-to-landscape rotation", JSON.stringify({ portraitState, landscapeState }));
  check(portraitState.pinDisplay === "none" && landscapeState.pinDisplay === "none", "orientation: rotation introduces no process pinning", JSON.stringify({ portraitState, landscapeState }));
  check(!portraitState.overflow && !landscapeState.overflow && landscapeState.stageWithinViewport, "orientation: portrait and landscape avoid horizontal overflow", JSON.stringify({ portraitState, landscapeState }));
  check(landscapeState.stageState === "animated" && landscapeState.layoutShift < 0.1, "orientation: stage animation remains stable after rotation", JSON.stringify(landscapeState));
  check(orientationEvents.sequenceRequests.length === 0, "orientation: iPad route never requests machining frames", `${orientationEvents.sequenceRequests.length} requests`);
  check(orientationEvents.consoleErrors.length === 0 && orientationEvents.pageErrors.length === 0, "orientation: no console or page errors", JSON.stringify(orientationEvents));
  report.push({ name: "ipad-orientation", portraitState, landscapeState, ...orientationEvents });
  await orientationContext.close();
  console.log("Completed iPad orientation probe.");

  console.log("Running WebKit mobile compatibility probe...");
  safariBrowser = await webkit.launch({ headless: true });
  const safariContext = await safariBrowser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const safariPage = await safariContext.newPage();
  const safariEvents = observePage(safariPage);
  await safariPage.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
  await safariPage.locator('[data-mobile-stage="3"]').scrollIntoViewIfNeeded();
  await safariPage.waitForFunction(() => document.querySelector('[data-mobile-stage="3"]')?.dataset.mobileStageState === "animated", undefined, { timeout: 5000 });
  await safariPage.setViewportSize({ width: 1180, height: 820 });
  await safariPage.evaluate(() => dispatchEvent(new Event("orientationchange")));
  await safariPage.waitForTimeout(500);
  await safariPage.locator('[data-mobile-stage="6"]').scrollIntoViewIfNeeded();
  await safariPage.waitForFunction(() => document.querySelector('[data-mobile-stage="6"]')?.dataset.mobileStageState === "animated", undefined, { timeout: 5000 });
  const safariState = await safariPage.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    mobileJourneyReady: document.documentElement.classList.contains("process-mobile-ready"),
    cinematicReady: document.documentElement.classList.contains("process-cinematic-ready"),
    pinDisplay: getComputedStyle(document.querySelector("[data-process-pin]")).display,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    animatedStages: document.querySelectorAll('[data-mobile-stage-state="animated"]').length,
    testedStageState: document.querySelector('[data-mobile-stage="6"]')?.dataset.mobileStageState,
    testedImage: document.querySelector('[data-mobile-stage="6"] img')?.currentSrc,
    testedImageWidth: document.querySelector('[data-mobile-stage="6"] img')?.naturalWidth,
    contactButton: Boolean(document.querySelector("[data-contact-button]")),
  }));
  await safariPage.screenshot({ path: path.join(output, "webkit-ipad-landscape-journey.png"), fullPage: false });
  check(safariState.mobileJourneyReady && !safariState.cinematicReady && safariState.pinDisplay === "none", "webkit: iPad-style journey uses the unpinned enhancement", JSON.stringify(safariState));
  check(!safariState.overflow && safariState.testedStageState === "animated", "webkit: animated stage remains within the landscape viewport", JSON.stringify(safariState));
  check(/-960\.(?:avif|webp)$/.test(safariState.testedImage || "") && safariState.testedImageWidth > 0 && safariState.contactButton, "webkit: optimised imagery and contact menu remain available", JSON.stringify(safariState));
  check(safariEvents.sequenceRequests.length === 0, "webkit: mobile journey requests no machining frames", `${safariEvents.sequenceRequests.length} requests`);
  check(safariEvents.consoleErrors.length === 0 && safariEvents.pageErrors.length === 0 && safariEvents.failedRequests.length === 0, "webkit: no console, page or request errors", JSON.stringify(safariEvents));
  report.push({ name: "webkit-ipad", ...safariState, ...safariEvents });
  await safariContext.close();
  await safariBrowser.close();
  safariBrowser = undefined;
  console.log("Completed WebKit mobile compatibility probe.");

  const result = {
    generatedAt: new Date().toISOString(),
    target: target.url,
    scenarios: report,
    assertions,
    passed: failures.length === 0,
  };
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`Browser QA ${result.passed ? "passed" : "failed"}: ${assertions.length - failures.length}/${assertions.length} assertions passed across ${report.length} scenarios.`);
  console.log(`Detailed report: ${path.join(output, "report.json")}`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAIL: ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`));
    process.exitCode = 1;
  }
} finally {
  await safariBrowser?.close();
  await browser?.close();
  if (localServer) await new Promise((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
}
