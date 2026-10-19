(function (root) {
  const CLUB = "2368312";
  function isDiscussionUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://www.strava.com" && /^\/clubs\/2368312\/discussion\/?$/.test(url.pathname);
    } catch { return false; }
  }
  function isMembersUrl(value) {
    try { const url = new URL(value); return url.origin === "https://www.strava.com" && /^\/clubs\/2368312\/members\/?$/.test(url.pathname); }
    catch { return false; }
  }
  async function findDiscussionTab(tabs, preferredId) {
    const [active] = await tabs.query({active: true, lastFocusedWindow: true});
    if (isDiscussionUrl(active?.url)) return active;
    const candidates = (await tabs.query({url: "https://www.strava.com/clubs/2368312/discussion*"}))
      .filter(tab => isDiscussionUrl(tab.url));
    return candidates.find(tab => tab.id === active?.id)
      ?? candidates.find(tab => tab.id === preferredId)
      ?? (candidates.length === 1 ? candidates[0] : null);
  }
  async function findMembersTab(tabs, preferredId) {
    const [active] = await tabs.query({active: true, lastFocusedWindow: true});
    if (isMembersUrl(active?.url)) return active;
    const candidates = (await tabs.query({url: "https://www.strava.com/clubs/2368312/members*"})).filter(tab => isMembersUrl(tab.url));
    return candidates.find(tab => tab.id === active?.id) ?? candidates.find(tab => tab.id === preferredId) ?? (candidates.length === 1 ? candidates[0] : null);
  }
  function detectAthleteId(doc) {
    const selectors = [".user-menu a[href], .user-nav a[href]", 'header a[href], nav a[href], [role="banner"] a[href]'];
    for (const selector of selectors) {
      for (const link of doc.querySelectorAll(selector)) {
        try {
          const url = new URL(link.getAttribute("href"), "https://www.strava.com");
          const match = url.pathname.match(/^\/athletes\/(\d+)\/?$/);
          if (url.origin === "https://www.strava.com" && match) return match[1];
        } catch {}
      }
    }
    return null;
  }
  function nextCursor(data, current) {
    if (!Array.isArray(data.entries)) throw new Error("Phản hồi không có entries.");
    if (data.pagination?.hasMore === false) return null;
    const next = Number(data.entries.at(-1)?.cursorData?.updated_at);
    if (!Number.isFinite(next) || next >= current) throw new Error("Cursor không tiến. Đã dừng để tránh lặp hoặc bỏ sót dữ liệu.");
    return next;
  }
  function mergeEntries(existing, incoming) {
    const map = new Map(existing.map(e => [String(e.post?.id ?? e.post?.entity_id), e]));
    for (const e of incoming) {
      const id = e.post?.id ?? e.post?.entity_id;
      if (id == null) throw new Error("Bài đăng thiếu ID.");
      map.set(String(id), e);
    }
    return [...map.values()];
  }
  function parseCode(text) {
    const m = String(text ?? "").match(/(?:^|[^\p{L}\p{N}])[lL][dDđĐ]\s*([1-5])\s*[_-]\s*(\d+)(?:\s*[_-]\s*([\d.,]+))?/u);
    if (!m) return null;
    const people = Number(m[2]);
    return {division: Number(m[1]), people, declaredSteps: m[3] ? Number(m[3].replace(/[.,]/g, "")) : null};
  }
  function stepsFromStats(stats) {
    const map = new Map((stats ?? []).map(s => [s.key, s.value]));
    for (const [key, label] of map) {
      if (key.endsWith("_subtitle") && /^(steps|số bước)$/i.test(String(label).trim())) {
        const raw = String(map.get(key.slice(0, -9)) ?? "").trim();
        if (!/^\d+(?:[,.\s\u00a0]\d{3})*$/.test(raw)) return null;
        const n = Number(raw.replace(/[,.\s\u00a0]/g, ""));
        return Number.isSafeInteger(n) ? n : null;
      }
    }
    return null;
  }
  // Posts are reports, never activities; title numbers are not trusted metrics.
  function normalizePhotos(photos) {
    if (!Array.isArray(photos)) return undefined;
    const safeUrl = value => {
      if (typeof value !== "string" || value.length > 4096) return null;
      try {const u = new URL(value); return u.protocol === "https:" && u.hostname === "dgtzuqphqg23d.cloudfront.net" && !u.username && !u.password && !u.port ? value : null;} catch {return null;}
    };
    return photos.filter(p => p && p.media_type === 1).flatMap(p => {
      const url = safeUrl(p.urls?.["1800"]), thumbnail = safeUrl(p.urls?.["100"]) || url;
      return url && thumbnail ? [{id:String(p.unique_id ?? p.id ?? "").slice(0,100),url,thumbnail_url:thumbnail,caption:String(p.caption ?? "").slice(0,200)}] : [];
    }).slice(0,10);
  }
  function normalizeActivityMedia(media) {
    if (!Array.isArray(media)) return undefined;
    return normalizePhotos(media.filter(m => m?.type === "Photo").map(m => ({
      id:m.id,media_type:1,caption:m.metadata?.caption,
      urls:{100:m.imageUrlWithMetadata?.imageUrl,1800:m.imageUrlWithMetadata?.imageUrl}
    })));
  }
  function normalizePosts(entries, observedAt = null) {
    return entries.flatMap(entry => {
      const p = entry.post ?? {}, author = p.athlete ?? p.author ?? {};
      const id = p.id ?? p.entity_id, meta = entry.report_metadata ?? {};
      const athlete = meta.athlete_id ?? p.athlete_id ?? author.id;
      if (!/^\d{1,15}$/.test(String(id ?? "")) || !/^\d{1,15}$/.test(String(athlete ?? ""))) return [];
      const body = String(p.post ?? "");
      const shared = (p.shared_content_v2 ?? []).filter(a => a.__typename === "Activity" && a.id);
      // Skip unrelated announcements, but retain previously fixed reports for reconciliation.
      if (!shared.length && !parseCode(body) && !/strava\.(?:com|app\.link)/i.test(body)) return [];
      const rawDate = p.date;
      const date = new Date(rawDate == null ? NaN : typeof rawDate === "number" ? (rawDate < 1e12 ? rawDate * 1000 : rawDate) : rawDate);
      return [{post_id:String(id),athlete_id:String(athlete),athlete_name:meta.athlete_name || p.originator_name || [author.firstName ?? author.firstname, author.lastName ?? author.lastname].filter(Boolean).join(" "),
        media:normalizePhotos(p.photos),title:body.slice(0,500),posted_at:Number.isNaN(date.getTime()) ? null : date.toISOString(),activity_ids:shared.map(a=>String(a.id)),kudos_count:Number.isInteger(p.kudos_count)&&p.kudos_count>=0&&p.kudos_count<=1000000?p.kudos_count:null,kudos_observed_at:entry.observed_at??observedAt}];
    });
  }
  function normalize(entries, config, observedAt = null) {
    const rows = new Map();
    for (const entry of entries) {
      const post = entry.post ?? {};
      const activities = (post.shared_content_v2 ?? []).filter(a => a.__typename === "Activity");
      for (const a of activities) {
        if (!a.id) continue;
        const date = /^\d{4}-\d{2}-\d{2}T/.test(a.startLocal ?? "") ? a.startLocal.slice(0, 10) : null;
        const steps = activities.length === 1 ? stepsFromStats(post.shared_content_activity_stats) : null;
        const fromTitle = parseCode(a.name), fromPost = parseCode(post.post);
        const code = fromTitle ?? fromPost;
        const warnings = [];
        if (steps === null) warnings.push("missing_steps");
        if (activities.length > 1) warnings.push("ambiguous_post_stats");
        if (!date) warnings.push("missing_activity_date");
        if (!code) warnings.push("missing_group_code");
        if (code && code.people < 1) warnings.push("invalid_people_count");
        if (fromTitle && fromPost && (fromTitle.division !== fromPost.division || fromTitle.people !== fromPost.people)) warnings.push("conflicting_group_code");
        if (code?.declaredSteps != null && steps !== null && code.declaredSteps !== steps) warnings.push("declared_steps_mismatch");
        const inPeriod = date ? date >= config.startDate && date <= config.endDate : false;
        const walk = a.activityKind?.sportType === "Walk";
        if (!walk) warnings.push("not_walk");
        if (date && !inPeriod) warnings.push("outside_event_period");
        const row = {
          media:normalizeActivityMedia(a.media),media_observed_at:entry.observed_at ?? observedAt,
          activity_id: String(a.id), athlete_id: a.athlete?.id ? String(a.athlete.id) : null,
          athlete_name: [a.athlete?.firstName, a.athlete?.lastName].filter(Boolean).join(" "),
          name: a.name ?? "", activity_url: `https://www.strava.com/activities/${a.id}`,
          start_local: a.startLocal ?? null, local_date: date, timezone: "Asia/Ho_Chi_Minh",
          timezone_assumption: "Activity startLocal is treated as Vietnam local time; source does not provide timezone.",
          sport_type: a.activityKind?.sportType ?? null, distance_m: a.scalars?.distance ?? null,
          elapsed_seconds: a.scalars?.elapsedTime ?? null,
          steps, declared_steps: code?.declaredSteps ?? null, division: code?.division ?? null,
          people_count: code?.people ?? null,
          proposed_points: steps !== null && code?.people >= 1 ? Math.round(steps * (1 + (code.people > 1 ? code.people / 10 : 0))) : null,
          eligible_for_review: walk && inPeriod, status: "pending", warnings,
          source_posts: [{post_id: String(post.id ?? post.entity_id), posted_at: post.date ?? null, body: post.post ?? ""}],
        };
        if (!row.athlete_id) row.warnings.push("missing_athlete");
        const prev = rows.get(row.activity_id);
        if (prev) {
          const sources = [...prev.source_posts, ...row.source_posts];
          const combinedWarnings = [...new Set([...prev.warnings, ...row.warnings])];
          if (prev.steps !== null && row.steps !== null && prev.steps !== row.steps) combinedWarnings.push("conflicting_steps");
          const newerMedia = row.media !== undefined && (prev.media === undefined || String(row.media_observed_at ?? "") >= String(prev.media_observed_at ?? ""));
          rows.set(row.activity_id, {...(prev.steps === null && row.steps !== null ? row : prev), media:newerMedia?row.media:prev.media,media_observed_at:newerMedia?row.media_observed_at:prev.media_observed_at,source_posts: sources, warnings: [...new Set(combinedWarnings)]});
        } else rows.set(row.activity_id, row);
      }
    }
    return [...rows.values()];
  }
  const api = {CLUB, isDiscussionUrl, isMembersUrl, findDiscussionTab, findMembersTab, detectAthleteId, nextCursor, mergeEntries, parseCode, stepsFromStats, normalizePhotos, normalizeActivityMedia, normalizePosts, normalize};
  if (typeof module !== "undefined") module.exports = api;
  else root.ReviveCore = api;
})(globalThis);
