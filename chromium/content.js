(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "recentRepos";
  const DISPLAY_COUNT_KEY = "recentReposDisplayCount";
  const MAX_STORED = 50;
  const DISPLAY_MIN = 1;
  const DISPLAY_MAX = 50;
  const DISPLAY_DEFAULT = 10;
  const SECTION_ID = "recent-repos-section";
  const LIST_SELECTOR = ".recent-repos-list";
  const ENHANCE_DEBOUNCE_MS = 120;
  const IGNORE_SELECTOR = "#recent-repos-section";
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

  function getSidebarUniversal(root = document) {
    const isRepoHref = (href) => /^\/[^/]+\/[^/]+\/?$/.test(href || "");

    const asides = Array.from(root.querySelectorAll("aside"))
      .filter(el => !el.querySelector(IGNORE_SELECTOR));
    let bestSidebar = null;
    let bestScore = 0;

    for (const aside of asides) {
      const repoLinks = Array.from(aside.querySelectorAll('a[href^="/"]')).filter((link) =>
        isRepoHref(link.getAttribute("href"))
      );

      const uniqueRepos = new Set(
        repoLinks.map((link) => link.getAttribute("href").replace(/\/$/, ""))
      );

      if (uniqueRepos.size >= 2 && uniqueRepos.size > bestScore) {
        bestSidebar = aside;
        bestScore = uniqueRepos.size;
      }
    }

    return bestSidebar;
  }

  function stripQueryAndHashFromPath(href) {
    if (!href) return href;
    const t = String(href);
    const i = t.search(/[?#]/);
    return i === -1 ? t : t.slice(0, i);
  }

  function repoFromRelativePath(href) {
    if (!href) return null;
    const t = String(href).trim();
    if (t === "" || !t.startsWith("/")) return null;
    const pathOnly = stripQueryAndHashFromPath(t);
    return parseRepoFromPathname(pathOnly);
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
      return repoFromRelativePath(t);
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
      ext.storage.local.get([DISPLAY_COUNT_KEY], (result) => {
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
      try {
        ext.storage.local.get([STORAGE_KEY], (result) => {
          try {
            const value = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];

            const valid = value.filter((item) => {
              if (
                !item ||
                typeof item.fullName !== "string" ||
                typeof item.href !== "string" ||
                typeof item.lastSeenAt !== "number"
              ) {
                return false;
              }
              const p = repoFromRelativePath(item.href);
              return p !== null && p.fullName === item.fullName;
            });

            const next = clampStored(valid);

            if (value.length !== next.length) {
              try {
                ext.storage.local.set({ [STORAGE_KEY]: next });
              } catch (e) {
                console.warn("⚠️ Failed to write storage (context gone):", e);
              }
            }

            resolve(next);
          } catch (innerErr) {
            console.warn("⚠️ Processing failed:", innerErr);
            resolve([]); // fail safe
          }
        });
      } catch (err) {
        console.warn("⚠️ Storage read failed (extension reloaded):", err);
        resolve([]); // fail safe
      }
    });
  }

  function writeRecentRepos(items) {
    return new Promise((resolve) => {
      ext.storage.local.set({ [STORAGE_KEY]: clampStored(items) }, () => resolve());
    });
  }

  function hashRepos(repos) {
    return repos.map((repo) => `${repo.fullName}:${repo.lastSeenAt}`).join("|");
  }

  function buildRecentSectionFromTop() {
    const wrapper = document.createElement("div");
    wrapper.id = SECTION_ID;
    wrapper.classList.add("recent-repos-section");

    const heading = document.createElement("h3");
    heading.textContent = "Recent repositories";
    heading.style.marginBottom = "6px";

    const list = document.createElement("ul");
    list.classList.add("recent-repos-list");
    list.style.listStyle = "none";
    list.style.padding = "0";
    list.style.margin = "0";

    wrapper.appendChild(heading);
    wrapper.appendChild(list);

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

  function renderRecentList(container, repos, topReposSection, displayCount) {
    const list = container.querySelector(LIST_SELECTOR) || findRepoListElement(container);
    if (!list) return;
    list.innerHTML = "";
    const reposHash = `${displayCount}|${hashRepos(repos)}`;
    if (reposHash === lastRenderedHash) return;
    lastRenderedHash = reposHash;
    if (!repos.length) {
      const empty = document.createElement("li");
      empty.textContent = "No repositories visited yet.";
      empty.style.opacity = "0.7";
      empty.style.padding = "4px 0";
      list.appendChild(empty);
      return;
    }
    repos.forEach((repo) => {
      const li = document.createElement("li");

      const a = document.createElement("a");
      a.href = repo.href;
      a.textContent = repo.fullName;
      a.style.display = "block";
      a.style.padding = "4px 0";

      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function findTopReposSectionInDashboard() {
    const sidebar = getSidebarUniversal();
    if (!sidebar) return null;

    const isRepoHref = (href) => /^\/[^/]+\/[^/]+\/?$/.test(href || "");

    const lists = Array.from(sidebar.querySelectorAll("ul, ol"));
    let bestList = null;
    let bestScore = 0;

    for (const list of lists) {
      if (list.closest("#recent-repos-section")) continue;
      const repoLinks = Array.from(list.querySelectorAll('a[href^="/"]')).filter((link) =>
        isRepoHref(link.getAttribute("href"))
      );

      const uniqueRepos = new Set(
        repoLinks.map((link) => link.getAttribute("href").replace(/\/$/, ""))
      );

      if (uniqueRepos.size >= 2 && uniqueRepos.size > bestScore) {
        bestList = list;
        bestScore = uniqueRepos.size;
      }
    }

    // return the parent container (your code expects section, not just list)
    if (!bestList) return null;

    // climb up until we hit a reasonable section container
    let section = bestList;
    while (section && section.parentElement && section.parentElement.tagName !== "ASIDE") {
      section = section.parentElement;
    }

    return section;
  }

  function ensureRecentSection(topReposSection) {
    if (document.getElementById(SECTION_ID)) {
      return document.getElementById(SECTION_ID);
    }
    if (!topReposSection) return null;
    const parent = topReposSection.parentElement;
    if (!parent) return null;
    let section = document.getElementById(SECTION_ID);
    if (!section) {
      section = buildRecentSectionFromTop(topReposSection);
      topReposSection.insertAdjacentElement("beforebegin", section);
      return section;
    }
    if (section.parentElement !== parent || section.nextElementSibling !== topReposSection) {
      topReposSection.insertAdjacentElement("beforebegin", section);
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
      const repo = repoFromRelativePath(href);
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

  console.log("🔥 enhanceSidebar running");
  async function enhanceSidebar() {
    if (document.getElementById(SECTION_ID) && lastRenderedHash) return;
    const topReposSection = findTopReposSectionInDashboard();
    console.log("TopReposSection:", topReposSection);
    if (!topReposSection) {
      console.log("Top section not ready yet...");
      return;
    }
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
    ext.storage.onChanged.addListener((changes, area) => {
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
