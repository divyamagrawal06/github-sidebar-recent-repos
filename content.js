(() => {
  const STORAGE_KEY = "recentRepos";
  const DISPLAY_COUNT_KEY = "recentReposDisplayCount";
  const MAX_STORED = 50;
  const DISPLAY_MIN = 1;
  const DISPLAY_MAX = 50;
  const DISPLAY_DEFAULT = 10;
  const SECTION_ID = "recent-repos-section";
  const LIST_SELECTOR = ".recent-repos-list";
  const ENHANCE_DEBOUNCE_MS = 120;
  const DASHBOARD_NAV_SELECTOR = 'nav[data-testid="dashboard-repositories"]';
  let observer = null;
  let clickTrackingAttached = false;
  let pendingEnhanceTimer = null;
  let lastRenderedHash = "";
  let visitDebounceTimer = null;

  const GITHUB_EXCLUDE_PATH_ROOT = new Set(
    "settings,login,signup,pricing,explore,marketplace,topics,sponsors,features,mobile,enterprise,team,about,security,git-guides,account,notifications,codespaces,collections,search,trending,pulls,issues,dashboard,new,organizations,orgs,users,gist,copilot,github-copilot,resources,community,projects,site".split(
      ","
    )
  );

  function isRepoHref(href) {
    return /^\/[^/]+\/[^/]+\/?$/.test(href);
  }

  function normalizeRepoFromHref(href) {
    const cleanedHref = href.replace(/\/$/, "");
    const parts = cleanedHref.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return {
      fullName: `${parts[0]}/${parts[1]}`,
      href: `/${parts[0]}/${parts[1]}`
    };
  }

  function parseRepoFromPathname(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    if (owner.toLowerCase() === "orgs" || owner.toLowerCase() === "users") return null;
    if (GITHUB_EXCLUDE_PATH_ROOT.has(owner.toLowerCase())) return null;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    if (owner.length > 39) return null;
    return { fullName: `${owner}/${repo}`, href: `/${owner}/${repo}` };
  }

  function hrefToRepoCandidate(href) {
    if (!href) return null;
    const t = String(href).trim();
    if (t === "" || t.startsWith("#") || /^(javascript|mailto|data|blob):/i.test(t)) return null;
    if (t.startsWith("/")) {
      return parseRepoFromPathname(t) || (isRepoHref(t) ? normalizeRepoFromHref(t) : null);
    }
    try {
      const u = new URL(t);
      const h = u.hostname.replace(/^www\./, "");
      if (h !== "github.com") return null;
      return parseRepoFromPathname(u.pathname);
    } catch {
      return null;
    }
  }

  function clampStored(items) {
    return items
      .slice()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_STORED);
  }

  function readDisplayCount() {
    return new Promise((resolve) => {
      chrome.storage.local.get([DISPLAY_COUNT_KEY], (result) => {
        const raw = result[DISPLAY_COUNT_KEY];
        let n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        if (!Number.isFinite(n)) n = DISPLAY_DEFAULT;
        n = Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, Math.round(n)));
        resolve(n);
      });
    });
  }

  function upsertRecentRepo(list, repo) {
    const withoutMatch = list.filter((item) => item.fullName !== repo.fullName);
    return clampStored([
      { fullName: repo.fullName, href: repo.href, lastSeenAt: Date.now() },
      ...withoutMatch
    ]);
  }

  function readAllStoredRecentRepos() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const value = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
        const valid = value.filter(
          (item) =>
            item &&
            typeof item.fullName === "string" &&
            typeof item.href === "string" &&
            typeof item.lastSeenAt === "number"
        );
        resolve(clampStored(valid));
      });
    });
  }

  function writeRecentRepos(items) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: clampStored(items) }, () => resolve());
    });
  }

  function hashRepos(repos) {
    return repos.map((repo) => `${repo.fullName}:${repo.lastSeenAt}`).join("|");
  }

  function buildRecentSectionFromTop(topReposSection) {
    const wrapper = topReposSection.cloneNode(true);
    wrapper.id = SECTION_ID;
    wrapper.classList.add("recent-repos-section");

    const heading = Array.from(
      wrapper.querySelectorAll("h2, h3, h4, [data-component='NavList.GroupHeading']")
    ).find((node) => /top repositories/i.test(node.textContent || ""));
    if (heading) {
      const labelDiv = heading.querySelector("div");
      if (labelDiv) {
        labelDiv.textContent = "Recent repositories";
      } else {
        heading.textContent = "Recent repositories";
      }
      heading.querySelector("button")?.remove();
      const tooltip = heading.querySelector("[class*='Tooltip'], [popover]");
      if (tooltip) tooltip.remove();
    }

    const repoList = findRepoListElement(wrapper);
    if (repoList) {
      repoList.classList.add("recent-repos-list");
      repoList.setAttribute("aria-label", "Recent repositories");
      Array.from(repoList.querySelectorAll("li")).forEach((li) => {
        if (
          li.querySelector("a[href^='/']") ||
          li.querySelector("[data-testid='dynamic-side-panel-items-show-more']")
        ) {
          li.remove();
        }
      });
      applyRecentGroupHeadingLayout(repoList.querySelector("li[data-component='GroupHeadingWrap']"));
    }

    return wrapper;
  }

  function applyRecentGroupHeadingLayout(headingLi) {
    if (!headingLi) return;
    headingLi.style.setProperty("box-sizing", "border-box", "important");
    headingLi.style.setProperty("min-height", "35px", "important");
    headingLi.style.setProperty("display", "flex", "important");
    headingLi.style.setProperty("align-items", "center", "important");
    headingLi.style.removeProperty("padding-top");
    headingLi.style.removeProperty("padding-bottom");
  }

  function findRepoListElement(sectionRoot) {
    if (!sectionRoot) return null;
    const firstRepoLink = sectionRoot.querySelector("a[href^='/']");
    if (firstRepoLink) {
      const owningList = firstRepoLink.closest("ul, ol");
      if (owningList) return owningList;
    }
    const lists = Array.from(sectionRoot.querySelectorAll("ul, ol"));
    return lists[lists.length - 1] || null;
  }

  function buildRecentHeadingItemFromTop(topReposSection) {
    const topHeadingItem = topReposSection?.querySelector("li[data-component='GroupHeadingWrap']");
    if (!topHeadingItem) return null;
    const cloned = topHeadingItem.cloneNode(true);
    applyRecentGroupHeadingLayout(cloned);
    const topHeading = topHeadingItem.querySelector("[data-component='NavList.GroupHeading']");
    const existingHeading = cloned.querySelector("[data-component='NavList.GroupHeading']");
    const heading = document.createElement("h3");
    heading.setAttribute("data-component", "NavList.GroupHeading");
    heading.className = (topHeading?.className || existingHeading?.className || "").toString();
    const labelDiv = document.createElement("div");
    labelDiv.textContent = "Recent repositories";
    heading.appendChild(labelDiv);
    if (existingHeading) {
      existingHeading.replaceWith(heading);
    } else {
      cloned.prepend(heading);
    }
    cloned.querySelector("button")?.remove();
    const tooltip = cloned.querySelector("[class*='Tooltip'], [popover]");
    if (tooltip) tooltip.remove();
    return cloned;
  }

  function buildAvatarUrl(owner) {
    return `https://github.com/${owner}.png?size=40`;
  }

  function updateTemplateItem(item, repo) {
    const [owner] = repo.fullName.split("/");
    const link = item.querySelector("a[href]") || item.querySelector("a");
    if (!(link instanceof HTMLAnchorElement)) {
      item.textContent = repo.fullName;
      return;
    }
    link.href = repo.href;
    link.removeAttribute("id");
    link.removeAttribute("aria-labelledby");
    const label = link.querySelector("[class*='ItemLabel'], [id$='--label']");
    if (label) {
      label.textContent = repo.fullName;
      label.removeAttribute("id");
    } else {
      const textNode = Array.from(link.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (textNode) {
        textNode.textContent = repo.fullName;
      } else {
        const span = document.createElement("span");
        span.textContent = repo.fullName;
        link.appendChild(span);
      }
    }
    const img = link.querySelector("img[data-component='Avatar'], img");
    if (img) {
      img.src = buildAvatarUrl(owner);
      img.alt = `@${owner}`;
      img.loading = "lazy";
      img.removeAttribute("srcset");
    }
  }

  function createItemFromTemplate(sampleItem, repo, sampleLinkClass) {
    if (sampleItem) {
      const cloned = sampleItem.cloneNode(true);
      updateTemplateItem(cloned, repo);
      return cloned;
    }
    const item = document.createElement("li");
    item.className = "prc-ActionList-ActionListItem-So4vC";
    const link = document.createElement("a");
    link.className = sampleLinkClass || "prc-ActionList-ActionListContent-KBb8- prc-Link-Link-9ZwDx";
    link.href = repo.href;
    link.setAttribute("data-size", "medium");
    link.style.setProperty("--subitem-depth", "0");
    const spacer = document.createElement("span");
    spacer.className = "prc-ActionList-Spacer-4tR2m";
    const leading = document.createElement("span");
    leading.className = "prc-ActionList-LeadingVisual-NBr28 prc-ActionList-VisualWrap-bdCsS";
    const avatar = document.createElement("img");
    const [owner] = repo.fullName.split("/");
    avatar.setAttribute("data-component", "Avatar");
    avatar.className = "prc-Avatar-Avatar-0xaUi";
    avatar.alt = `@${owner}`;
    avatar.width = 16;
    avatar.height = 16;
    avatar.src = buildAvatarUrl(owner);
    leading.appendChild(avatar);
    const sub = document.createElement("span");
    sub.className = "prc-ActionList-ActionListSubContent-gKsFp";
    sub.setAttribute("data-component", "ActionList.Item--DividerContainer");
    const label = document.createElement("span");
    label.className = "prc-ActionList-ItemLabel-81ohH";
    label.textContent = repo.fullName;
    sub.appendChild(label);
    link.appendChild(spacer);
    link.appendChild(leading);
    link.appendChild(sub);
    item.appendChild(link);
    return item;
  }

  function renderRecentList(container, repos, topReposSection, displayCount) {
    const list = container.querySelector(LIST_SELECTOR) || findRepoListElement(container);
    if (!list) return;
    const reposHash = `${displayCount}|${hashRepos(repos)}`;
    if (reposHash === lastRenderedHash) return;
    lastRenderedHash = reposHash;
    let headingItem = list.querySelector("li[data-component='GroupHeadingWrap']");
    if (!headingItem) {
      headingItem = buildRecentHeadingItemFromTop(topReposSection);
      if (headingItem) list.prepend(headingItem);
    }
    applyRecentGroupHeadingLayout(headingItem);
    const sampleAnchor = topReposSection?.querySelector("a[href^='/']");
    const sampleItem = sampleAnchor ? sampleAnchor.closest("li") : null;
    const sampleLink = sampleItem?.querySelector("a");
    Array.from(list.querySelectorAll("li")).forEach((li) => {
      const hasRepoLink = !!li.querySelector("a[href^='/']");
      const isShowMoreControl = !!li.querySelector("[data-testid='dynamic-side-panel-items-show-more']");
      const isHeading = li.getAttribute("data-component") === "GroupHeadingWrap";
      if ((hasRepoLink || isShowMoreControl) && !isHeading) {
        li.remove();
      }
    });
    if (!repos.length) {
      const empty = document.createElement("li");
      empty.className = sampleItem?.className || "mt-2";
      empty.textContent = "No repositories visited yet.";
      list.appendChild(empty);
      return;
    }
    repos.forEach((repo) => {
      list.appendChild(createItemFromTemplate(sampleItem, repo, sampleLink?.className));
    });
  }

  function findTopReposSectionInDashboard() {
    const nav = document.querySelector(DASHBOARD_NAV_SELECTOR);
    if (!nav) return null;
    const groupItems = Array.from(nav.querySelectorAll("li.prc-ActionList-Group-lMIPQ"));
    return groupItems.find((group) => /top repositories/i.test(group.textContent || "")) || null;
  }

  function ensureRecentSection(topReposSection) {
    if (!topReposSection) return null;
    const parent = topReposSection.parentElement;
    if (!parent) return null;
    let section = document.getElementById(SECTION_ID);
    if (!section) {
      section = buildRecentSectionFromTop(topReposSection);
      parent.insertBefore(section, topReposSection);
      return section;
    }
    if (section.parentElement !== parent || section.nextElementSibling !== topReposSection) {
      parent.insertBefore(section, topReposSection);
    }
    return section;
  }

  async function persistRepoVisit(repo) {
    if (!repo) return;
    const current = await readAllStoredRecentRepos();
    const updated = upsertRecentRepo(current, repo);
    await writeRecentRepos(updated);
    lastRenderedHash = "";
    scheduleEnhance();
  }

  async function recordRepoFromLink(link) {
    if (!link || !link.getAttribute) return;
    const repo = hrefToRepoCandidate(link.getAttribute("href"));
    if (!repo) return;
    await persistRepoVisit(repo);
  }

  async function recordVisitFromCurrentUrl() {
    const repo = parseRepoFromPathname(window.location.pathname);
    if (!repo) return;
    await persistRepoVisit(repo);
  }

  function scheduleRecordVisitFromUrl() {
    if (visitDebounceTimer) window.clearTimeout(visitDebounceTimer);
    visitDebounceTimer = window.setTimeout(() => {
      visitDebounceTimer = null;
      void recordVisitFromCurrentUrl();
    }, 50);
  }

  function mergeTopIntoStoredHistory(current, topReposSection) {
    if (!topReposSection || current.length >= MAX_STORED) {
      return clampStored(current);
    }
    const fromTop = collectReposFromTopSection(topReposSection);
    const seen = new Set(current.map((r) => r.fullName));
    const merged = [...current];
    for (const repo of fromTop) {
      if (merged.length >= MAX_STORED) break;
      if (seen.has(repo.fullName)) continue;
      merged.push({ fullName: repo.fullName, href: repo.href, lastSeenAt: 0 });
      seen.add(repo.fullName);
    }
    return clampStored(merged);
  }

  function collectReposFromTopSection(topReposSection) {
    if (!topReposSection) return [];
    const links = Array.from(topReposSection.querySelectorAll("a[href^='/']"));
    const repos = [];
    const seen = new Set();
    links.forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!isRepoHref(href)) return;
      const repo = normalizeRepoFromHref(href);
      if (!repo || seen.has(repo.fullName)) return;
      seen.add(repo.fullName);
      repos.push(repo);
    });
    return repos;
  }

  function withBackfilledRepos(recentRepos, topReposSection, limit) {
    const primary = recentRepos.slice(0, limit);
    if (primary.length >= limit) return primary;
    const topRepos = collectReposFromTopSection(topReposSection);
    const seen = new Set(primary.map((repo) => repo.fullName));
    const merged = [...primary];
    for (const repo of topRepos) {
      if (merged.length >= limit) break;
      if (seen.has(repo.fullName)) continue;
      merged.push({ fullName: repo.fullName, href: repo.href, lastSeenAt: 0 });
      seen.add(repo.fullName);
    }
    return merged;
  }

  function attachRepoClickTracking() {
    if (clickTrackingAttached) return;
    clickTrackingAttached = true;
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest("a[href]");
        if (link) recordRepoFromLink(link);
      },
      { capture: true }
    );
  }

  async function enhanceSidebar() {
    const topReposSection = findTopReposSectionInDashboard();
    if (!topReposSection) return;
    const recentSection = ensureRecentSection(topReposSection);
    if (!recentSection) return;
    const stored = await readAllStoredRecentRepos();
    const expanded = mergeTopIntoStoredHistory(stored, topReposSection);
    if (expanded.length > stored.length) {
      await writeRecentRepos(expanded);
    }
    const displayCount = await readDisplayCount();
    renderRecentList(
      recentSection,
      withBackfilledRepos(expanded, topReposSection, displayCount),
      topReposSection,
      displayCount
    );
  }

  function scheduleEnhance() {
    if (pendingEnhanceTimer) window.clearTimeout(pendingEnhanceTimer);
    pendingEnhanceTimer = window.setTimeout(() => {
      pendingEnhanceTimer = null;
      enhanceSidebar();
    }, ENHANCE_DEBOUNCE_MS);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scheduleEnhance());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    attachRepoClickTracking();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes[STORAGE_KEY] || changes[DISPLAY_COUNT_KEY])) {
        lastRenderedHash = "";
        scheduleEnhance();
      }
    });
    scheduleRecordVisitFromUrl();
    scheduleEnhance();
    startObserver();
    const onNav = () => {
      scheduleRecordVisitFromUrl();
      scheduleEnhance();
    };
    window.addEventListener("popstate", onNav);
    document.addEventListener("turbo:load", onNav);
    document.addEventListener("pjax:end", onNav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
