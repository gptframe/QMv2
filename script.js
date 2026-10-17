(() => {
  const header = document.querySelector('[data-header]');
  const menuButton = document.querySelector('[data-menu-button]');
  const menu = document.querySelector('[data-menu]');
  const contact = document.querySelector('[data-contact]');
  const contactButton = document.querySelector('[data-contact-button]');
  const contactMenu = document.querySelector('[data-contact-menu]');
  const contactItems = [...document.querySelectorAll('[data-contact-menu] [role="menuitem"]')];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const closeContactMenu = (returnFocus = false) => {
    if (!contactButton || !contactMenu) return;
    contactButton.setAttribute('aria-expanded', 'false');
    contactMenu.hidden = true;
    if (returnFocus) contactButton.focus();
  };

  const openContactMenu = (focusTarget = null) => {
    if (!contactButton || !contactMenu) return;
    contactButton.setAttribute('aria-expanded', 'true');
    contactMenu.hidden = false;
    if (focusTarget === 'first') contactItems[0]?.focus();
    if (focusTarget === 'last') contactItems[contactItems.length - 1]?.focus();
  };

  const closeMenu = (returnFocus = false) => {
    if (!menuButton || !menu) return;
    closeContactMenu();
    menuButton.setAttribute('aria-expanded', 'false');
    menu.classList.remove('is-open');
    if (returnFocus) menuButton.focus();
  };

  menuButton?.addEventListener('click', () => {
    const willOpen = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(willOpen));
    menu?.classList.toggle('is-open', willOpen);
  });

  contactButton?.addEventListener('click', () => {
    const willOpen = contactButton.getAttribute('aria-expanded') !== 'true';
    if (willOpen) openContactMenu();
    else closeContactMenu();
  });

  contactButton?.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    openContactMenu(event.key === 'ArrowUp' ? 'last' : 'first');
  });

  contactMenu?.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const currentIndex = contactItems.indexOf(document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % contactItems.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + contactItems.length) % contactItems.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = contactItems.length - 1;
    contactItems[nextIndex]?.focus();
  });

  menu?.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && contactButton?.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      closeContactMenu(true);
      return;
    }

    if (menuButton?.getAttribute('aria-expanded') !== 'true') return;
    if (event.key === 'Escape') closeMenu(true);
    if (event.key !== 'Tab' || !menu) return;

    const focusable = [menuButton, ...menu.querySelectorAll('a[href], button:not([disabled])')].filter((element) => !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (contactButton?.getAttribute('aria-expanded') === 'true' && !contact?.contains(event.target)) closeContactMenu();
    if (!menu?.classList.contains('is-open')) return;
    if (!menu.contains(event.target) && !menuButton?.contains(event.target)) closeMenu();
  });

  const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 24);
  updateHeader();
  addEventListener('scroll', updateHeader, { passive: true });

  const capabilityTabs = [...document.querySelectorAll('[data-capability]')];
  const capabilityMedia = document.querySelector('.capability-media');
  const capabilityAvif = document.querySelector('[data-capability-avif]');
  const capabilityWebp = document.querySelector('[data-capability-webp]');
  const capabilityImage = document.querySelector('[data-capability-image]');
  const capabilityKicker = document.querySelector('[data-capability-kicker]');
  const capabilityTitle = document.querySelector('[data-capability-title]');
  const capabilityCopy = document.querySelector('[data-capability-copy]');
  let capabilityTimer;

  const setCapability = (tab, focus = false) => {
    if (!tab || tab.getAttribute('aria-selected') === 'true') {
      if (focus) tab?.focus();
      return;
    }

    capabilityTabs.forEach((candidate) => {
      const active = candidate === tab;
      candidate.setAttribute('aria-selected', String(active));
      candidate.tabIndex = active ? 0 : -1;
    });

    capabilityMedia?.classList.add('is-changing');
    clearTimeout(capabilityTimer);
    capabilityTimer = setTimeout(() => {
      const base = tab.dataset.base;
      const directImage = tab.dataset.image || '';
      const [width, height] = (tab.dataset.ratio || '1536 1024').split(' ');
      if (capabilityAvif) capabilityAvif.srcset = directImage || `assets/${base}-960.avif 960w, assets/${base}-1536.avif 1536w`;
      if (capabilityWebp) capabilityWebp.srcset = directImage || `assets/${base}-960.webp 960w, assets/${base}-1536.webp 1536w`;
      if (capabilityImage) {
        capabilityImage.src = directImage || `assets/${base}-1536.webp`;
        capabilityImage.alt = tab.dataset.alt || '';
        capabilityImage.width = Number(width);
        capabilityImage.height = Number(height);
      }
      if (capabilityKicker) capabilityKicker.textContent = tab.dataset.kicker || '';
      if (capabilityTitle) capabilityTitle.textContent = tab.dataset.title || '';
      if (capabilityCopy) capabilityCopy.textContent = tab.dataset.copy || '';
      capabilityMedia?.setAttribute('aria-labelledby', tab.id);
      requestAnimationFrame(() => capabilityMedia?.classList.remove('is-changing'));
    }, reducedMotion ? 0 : 135);

    if (focus) tab.focus();
  };

  capabilityTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setCapability(tab));
    tab.addEventListener('focus', () => setCapability(tab));
    tab.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') setCapability(tab);
    });
    tab.addEventListener('keydown', (event) => {
      const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % capabilityTabs.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + capabilityTabs.length) % capabilityTabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = capabilityTabs.length - 1;
      setCapability(capabilityTabs[nextIndex], true);
    });
  });

  if (reducedMotion || !window.gsap || !window.ScrollTrigger) return;

  const { gsap } = window;
  gsap.registerPlugin(window.ScrollTrigger);
  document.documentElement.classList.add('motion-ready');

  const processScroll = document.querySelector('[data-process-scroll]');
  const processPin = document.querySelector('[data-process-pin]');
  const scenes = gsap.utils.toArray('[data-process-scene]');
  const captions = gsap.utils.toArray('[data-process-caption]');
  const steps = [...document.querySelectorAll('[data-process-step]')];
  const progressFill = document.querySelector('[data-process-fill]');
  const progressCursor = document.querySelector('[data-process-cursor]');
  const stageLive = document.querySelector('[data-stage-live]');
  const stageReadout = document.querySelector('[data-stage-readout]');
  const routeNodes = gsap.utils.toArray('[data-route-node]');
  const measureLines = gsap.utils.toArray('[data-measure-line]');
  const machineRing = document.querySelector('[data-machine-ring]');
  const inspectionReticle = document.querySelector('[data-inspection-reticle]');
  const releaseMark = document.querySelector('[data-release-mark]');
  const machiningCanvas = document.querySelector('[data-machining-sequence]');
  const machiningScene = machiningCanvas?.closest('[data-process-scene]');
  const mobileStages = gsap.utils.toArray('[data-mobile-stage]');
  const stageNames = [
    'Engineering requirement',
    'Material',
    'Preparation',
    'Machining',
    'Secondary operations',
    'Inspection',
    'Finished component',
    'Delivery and accountability'
  ];

  const compactJourney = matchMedia('(max-width: 1080px), (hover: none), (pointer: coarse)').matches;
  const desktopJourney = !compactJourney;

  if (desktopJourney && processScroll && processPin && scenes.length === 8 && captions.length === 8) {
    document.documentElement.classList.add('process-cinematic-ready');
    gsap.set(scenes, { autoAlpha: 0, scale: 1.028, clipPath: 'circle(82% at 72% 50%)' });
    gsap.set(scenes[0], { autoAlpha: 1, scale: 1.005 });
    gsap.set(captions, { autoAlpha: 0, y: 30 });
    gsap.set(captions[0], { autoAlpha: 1, y: 0 });
    gsap.set(routeNodes, { autoAlpha: 0, y: 18 });
    gsap.set(measureLines, { scaleX: 0 });
    gsap.set(machineRing, { autoAlpha: 0, rotation: -40, scale: 0.68 });
    gsap.set(inspectionReticle, { autoAlpha: 0, scale: 0.34 });
    gsap.set(releaseMark, { autoAlpha: 0, y: 12 });

    let activeStage = 0;
    const updateStage = (nextStage) => {
      if (nextStage === activeStage) return;
      activeStage = nextStage;
      const padded = String(nextStage).padStart(2, '0');
      if (stageLive) stageLive.textContent = `Stage ${padded} of 8: ${stageNames[nextStage]}.`;
      if (stageReadout) stageReadout.textContent = `Stage ${padded} · 8 states`;
      steps.forEach((step, index) => {
        step.classList.toggle('is-active', index === nextStage);
        step.classList.toggle('is-complete', index < nextStage);
      });
    };

    const journey = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: processScroll,
        start: 'top top',
        end: () => `+=${Math.max(innerHeight * 6.2, 4400)}`,
        pin: processPin,
        pinSpacing: true,
        scrub: 0.72,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => updateStage(Math.min(7, Math.floor(self.progress * 8)))
      }
    });

    const machiningSequence = (() => {
      if (!machiningCanvas || !machiningScene) return null;
      const frameCount = Number(machiningCanvas.dataset.frameCount) || 32;
      const tier = innerWidth >= 1280 ? 1536 : 960;
      const context = machiningCanvas.getContext('2d', { alpha: false });
      if (!context) return null;

      machiningCanvas.width = tier;
      machiningCanvas.height = tier;
      machiningCanvas.dataset.sequenceTier = String(tier);
      machiningCanvas.dataset.sequenceStatus = 'idle';
      machiningCanvas.dataset.requestedFrame = '0';
      const frames = new Array(frameCount);
      let requestedFrame = 0;
      let started = false;

      const drawRequested = () => {
        if (!frames[0]) return;
        let selected = requestedFrame;
        if (!frames[selected]) {
          const loaded = frames
            .map((image, index) => image ? index : -1)
            .filter((index) => index >= 0);
          selected = loaded.reduce((closest, index) => (
            Math.abs(index - requestedFrame) < Math.abs(closest - requestedFrame) ? index : closest
          ), loaded[0]);
        }
        context.clearRect(0, 0, tier, tier);
        context.drawImage(frames[selected], 0, 0, tier, tier);
        machiningCanvas.dataset.sequenceFrame = String(selected);
        machiningScene.classList.add('is-sequence-ready');
      };

      const loadFrame = (index) => new Promise((resolve) => {
        if (frames[index]) {
          resolve(true);
          return;
        }
        const image = new Image();
        image.decoding = 'async';
        image.onload = async () => {
          try { await image.decode(); } catch { /* onload confirms a usable fallback decode path */ }
          frames[index] = image;
          drawRequested();
          resolve(true);
        };
        image.onerror = () => resolve(false);
        image.src = `assets/cinematic/machining/${tier}/frame-${String(index).padStart(2, '0')}.avif`;
      });

      const start = async () => {
        if (started) return;
        started = true;
        machiningCanvas.dataset.sequenceStatus = 'loading';
        await loadFrame(0);
        await loadFrame(frameCount - 1);
        const queue = Array.from({ length: frameCount - 2 }, (_, index) => index + 1);
        const workers = Array.from({ length: 4 }, async () => {
          while (queue.length) await loadFrame(queue.shift());
        });
        await Promise.all(workers);
        const loadedCount = frames.filter(Boolean).length;
        machiningCanvas.dataset.loadedFrames = String(loadedCount);
        machiningCanvas.dataset.sequenceStatus = loadedCount === frameCount ? 'complete' : 'degraded';
        drawRequested();
      };

      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          start();
        }, { rootMargin: '20% 0px', threshold: 0 });
        observer.observe(processScroll);
      }

      return {
        setFrame(value) {
          requestedFrame = Math.max(0, Math.min(frameCount - 1, Math.round(value)));
          machiningCanvas.dataset.requestedFrame = String(requestedFrame);
          drawRequested();
        }
      };
    })();

    journey.to(scenes[0], { scale: 1.018, duration: 0.72 }, 0);
    journey.to(progressFill, { scaleX: 1, duration: 7.8 }, 0);
    journey.to(progressCursor, { left: '100%', duration: 7.8 }, 0);
    const machiningFrame = { value: 0 };
    journey.to(machiningFrame, {
      value: 31,
      duration: 0.86,
      onUpdate: () => machiningSequence?.setFrame(machiningFrame.value)
    }, 2.60);

    for (let index = 1; index < scenes.length; index += 1) {
      const at = index;
      journey
        .to(captions[index - 1], { autoAlpha: 0, y: -22, duration: 0.18 }, at - 0.48)
        .to(scenes[index - 1], { autoAlpha: 0.12, scale: 0.992, duration: 0.66 }, at - 0.46)
        .fromTo(
          scenes[index],
          { autoAlpha: 0, scale: index === 5 ? 1.018 : 1.035, clipPath: 'circle(7% at 72% 50%)' },
          { autoAlpha: 1, scale: 1.005, clipPath: 'circle(82% at 72% 50%)', duration: index === 5 ? 0.98 : 0.76 },
          at - 0.42
        )
        .fromTo(
          captions[index],
          { autoAlpha: 0, y: 30 },
          { autoAlpha: 1, y: 0, duration: index === 5 ? 0.34 : 0.22, ease: 'power2.out' },
          at - 0.26
        )
        .set(scenes[index - 1], { autoAlpha: 0 }, at + 0.22);
    }

    journey
      .to(machineRing, { autoAlpha: 0.72, rotation: 90, scale: 0.76, duration: 0.58 }, 2.62)
      .to(machineRing, { rotation: 205, duration: 0.72 }, 3.18)
      .to(machineRing, { autoAlpha: 0, scale: 0.82, duration: 0.28 }, 3.65)
      .to(routeNodes[0], { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 3.64)
      .to(routeNodes[1], { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 3.76)
      .to(routeNodes[2], { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 3.88)
      .to(routeNodes, { autoAlpha: 0, y: -10, duration: 0.24 }, 4.5)
      .to(measureLines[0], { scaleX: 1, duration: 0.4, ease: 'power1.inOut' }, 4.76)
      .to(measureLines[1], { scaleX: 1, duration: 0.36, ease: 'power1.inOut' }, 4.92)
      .to(inspectionReticle, { autoAlpha: 0.65, scale: 0.46, duration: 0.7, ease: 'power1.inOut' }, 4.72)
      .to([measureLines, inspectionReticle], { autoAlpha: 0, duration: 0.32 }, 5.55)
      .to(releaseMark, { autoAlpha: 1, y: 0, duration: 0.42, ease: 'power2.out' }, 5.82)
      .to(releaseMark, { autoAlpha: 0, y: -8, duration: 0.24 }, 6.58)
      .to(scenes[7], { scale: 1, duration: 0.54 }, 7.18);

    const heroMotion = gsap.timeline({
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.7 }
    });
    heroMotion
      .to('[data-hero-image]', { yPercent: 5, scale: 1.045, ease: 'none' }, 0)
      .to('[data-hero-copy]', { y: -42, autoAlpha: 0.62, ease: 'none' }, 0);

    gsap.from('.process-intro > *', {
      autoAlpha: 0,
      y: 34,
      duration: 0.82,
      stagger: 0.12,
      ease: 'power2.out',
      scrollTrigger: { trigger: '.process-intro', start: 'top 76%', once: true }
    });

    window.ScrollTrigger.batch('.reveal-item', {
      start: 'top 89%',
      once: true,
      onEnter: (items) => gsap.from(items, {
        y: 24,
        duration: 0.68,
        stagger: 0.075,
        ease: 'power2.out',
        overwrite: true
      })
    });

    addEventListener('load', () => window.ScrollTrigger.refresh(), { once: true });
  }

  if (!desktopJourney && processScroll && mobileStages.length === 8) {
    document.documentElement.classList.add('process-mobile-ready');

    let activeMobileStage = -1;
    const updateMobileStage = (nextStage) => {
      if (nextStage === activeMobileStage) return;
      activeMobileStage = nextStage;
      mobileStages.forEach((stage, index) => stage.classList.toggle('is-mobile-active', index === nextStage));
      if (stageLive) {
        const padded = String(nextStage).padStart(2, '0');
        stageLive.textContent = `Stage ${padded} of 8: ${stageNames[nextStage]}.`;
      }
    };

    mobileStages.forEach((stage, index) => {
      const media = stage.querySelector('picture');
      const image = stage.querySelector('img');
      const copy = stage.querySelector(':scope > div');
      stage.dataset.mobileStageState = 'ready';
      gsap.set(stage, { autoAlpha: 0.78, y: 28 });
      gsap.set(media, { autoAlpha: 0.7, scale: 1.04, force3D: true });
      gsap.set(copy, { autoAlpha: 0.68, y: 18, force3D: true });

      const reveal = gsap.timeline({
        paused: true,
        defaults: { overwrite: 'auto' },
        onStart: () => { stage.dataset.mobileStageState = 'animating'; },
        onComplete: () => { stage.dataset.mobileStageState = 'animated'; },
        onReverseComplete: () => { stage.dataset.mobileStageState = 'ready'; }
      });
      reveal
        .to(stage, { autoAlpha: 1, y: 0, duration: 0.62, ease: 'power2.out' }, 0)
        .to(media, { autoAlpha: 1, scale: 1, duration: 0.82, ease: 'power2.out' }, 0)
        .to(copy, { autoAlpha: 1, y: 0, duration: 0.58, ease: 'power2.out' }, 0.08);

      const playReveal = () => {
        updateMobileStage(index);
        if (!image || image.complete) {
          reveal.play();
          return;
        }
        stage.dataset.mobileStageState = 'waiting-for-image';
        const resume = () => reveal.play();
        image.addEventListener('load', resume, { once: true });
        image.addEventListener('error', resume, { once: true });
      };

      window.ScrollTrigger.create({
        trigger: stage,
        start: 'top 88%',
        end: 'bottom 18%',
        invalidateOnRefresh: true,
        onEnter: playReveal,
        onEnterBack: playReveal,
        onLeaveBack: () => reveal.reverse()
      });
    });

    updateMobileStage(0);

    gsap.from('.process-intro > *', {
      autoAlpha: 0,
      y: 26,
      duration: 0.68,
      stagger: 0.1,
      ease: 'power2.out',
      scrollTrigger: { trigger: '.process-intro', start: 'top 84%', once: true }
    });

    window.ScrollTrigger.batch('.reveal-item', {
      start: 'top 92%',
      once: true,
      onEnter: (items) => gsap.from(items, {
        y: 18,
        duration: 0.54,
        stagger: 0.055,
        ease: 'power2.out',
        overwrite: true
      })
    });

    const refreshMobileJourney = () => requestAnimationFrame(() => window.ScrollTrigger.refresh());
    addEventListener('load', refreshMobileJourney, { once: true });
    addEventListener('orientationchange', refreshMobileJourney, { passive: true });
  }
})();
