# REVIVE Strava Sync

Local Chrome Manifest V3 extension for club 2368312. No build, dependencies, secrets, or server deployment required.

## Install

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Enable Developer mode, choose **Load unpacked**, and select this directory.
3. Sign into Strava and open the club's **Discussion** or **Members** page.
4. Click the extension icon to open the Chrome sidebar and choose **Hoạt động** or **Thành viên**.

## Operation

The extension detects the authenticated athlete from the visible profile link. A content runner coordinates one request at a time; `chrome.scripting.executeScript` with `world: MAIN` performs the same-origin JSON fetch in the page context. No cookie extraction, cookies permission, external endpoints, or credentials are used.

The initial cursor is the current Unix time plus one second. Subsequent requests use the last entry's `cursorData.updated_at`, as observed in the supplied feed. A non-decreasing cursor, malformed response, HTTP error, or 30-second timeout stops the sync and preserves the last saved checkpoint. Requests are spaced one second apart; there is no automatic retry of 429/auth errors. Resume after correcting the issue.

Closing the sidebar does not stop the content runner. Closing/reloading/navigating the Strava tab stops it; reopen the sidebar on the discussion page and choose **Tiếp tục**. Progress is saved per completed page in `chrome.storage.local`. Resume requires the same Strava athlete. A new run replaces the local dataset after confirmation. Export before replacing it. Local storage is used rather than sync storage; `unlimitedStorage` accommodates raw club post JSON. Uninstalling removes local data.

Stop finishes the current request before saving. A maximum of 5,000 pages prevents an unbounded loop. Fetching does not stop based on post dates because older posts can reference newer activities. Event dates only filter the normalized export; raw export retains all fetched posts.

## Exports

- **Xuất JSON gốc**: source entries, cursor, completion flag, event date configuration.
- **Xuất activities**: unique activity IDs, activity athlete, source post provenance, actual Steps, declared steps, parsed division/party size, proposed points, warnings and pending review status. In-period Walk activities are in `activities`; all other activities are in `excluded`.

Activity `startLocal` is assumed to be Vietnam time, since the observed feed does not include an activity timezone. Steps are matched by the subtitle (`Steps` / `Số bước`), never by fixed stat position or title. Missing Steps remain null. Multiple activity attachments have ambiguous aggregate stats and require review. Counts greater than one use `round(steps * (1 + people / 10))`; solo receives base steps. These are proposed points only; this extension cannot approve or write competition points.

The feed is an undocumented web endpoint; Chrome runtime behavior and pagination completeness must be verified after installation. Same-timestamp pagination boundaries cannot be guaranteed from a timestamp-only cursor without observing Strava's contract. Cursor anomalies stop rather than silently skip entries. MAIN-world results are page-controlled and must be validated by any future server importer. No Supabase upload is implemented in this version.

## Validation

`npm test` and `npm run check`. The core tests cover pagination guards, integer Steps parsing, syntax variants, deduplication, event boundaries, solo/group scoring and ambiguous stats. The runner harness checks two-page persistence, continuation and errors. These checks are not a claim of live Chrome installation or production Strava sync.

Reference: https://developer.chrome.com/docs/extensions/reference/api/scripting

## Version 0.2 update

Requires Chrome 116+. The toolbar icon opens the native side panel. Reload the extension in chrome://extensions, then reload the Strava tab once to replace the old content runner. The account detector now searches exact athlete profile paths in the account menu, skipping `/training/log` links that previously caused a false not-logged-in error. The sidebar updates the connection on tab changes.

## Version 0.2.1 update

Explicit host access to `https://www.strava.com/clubs/2368312/*` allows the persistent side panel to identify and inject into the club tab without relying solely on a temporary activeTab grant. The tab resolver checks the last focused window, then permitted discussion tabs, and never chooses an arbitrary unrelated tab. Reload the extension and allow its Strava site access if Chrome/Edge prompts, then reload Strava. The sidebar header shows 0.2.1. Existing collected entries are preserved.

## Version 0.2.2 update

Added 16px above the sync controls and consistent 10px gaps between buttons. Reload the unpacked extension and reopen its side panel; the header shows 0.2.2. This extension uses plain HTML/CSS/JavaScript directly and requires no build step.

## Version 0.3.0: direct REVIVE sync

Reload the extension and then the Strava discussion tab. Enter the shared REVIVE secret once in the sidebar and click **Lưu mã**. The secret is saved only in trusted extension storage, never in the Strava page context. This also sends previously collected data. After each new feed page, the worker normalizes activities and uploads batches of at most 50 (including excluded activities, so the website can show them separately).

The fixed destination is `https://btn-tmg-strava-tracker.vercel.app/api/extension/activities`. This version requests access to that domain. New activities remain pending; duplicates are skipped and approved data is never overwritten. An upload error pauses automatic sends while crawling can continue; use **Gửi lại** to retry without clearing the local dataset. Incomplete athlete IDs/dates remain local and are reported in the delivery counts. **Dữ liệu nguồn** retains the raw JSON download for troubleshooting. The normalized export and website JSON import are replaced by direct sync.

Website configuration: `STRAVA_SYNC_SECRET` is a server-only Vercel environment variable. Supabase stores its SHA256 hash in the private configuration table and allows only the bounded, rate-limited import RPC with a valid secret. It does not need a service-role key. Keep the local secret file outside this distributable extension directory; do not share it or commit it. Rotate by updating both the server env and database hash, deploying, then entering the new secret in the sidebar.

## Version 0.4.0: member roster sync

Open `https://www.strava.com/clubs/2368312/members`, select **Thành viên**, and click **Đồng bộ thành viên**. The extension reads the linked pagination pages from the authenticated Strava page, deduplicates by athlete ID, and sends the roster to `/api/extension/members` with the same saved secret. It refuses to upload if Strava reports a total that does not match the collected rows. Keep the tab open while it reads pages.

The import requires a complete roster and writes only the Strava name, Strava club role, source URL, and sync time. Existing BTN names, division/group assignments, linked accounts, and active flags are preserved. New roster rows start with database defaults and are not linked to login accounts. Missing members are never deleted or deactivated. Each sync writes one Audit entry with new, updated, and unchanged counts. Reload the unpacked extension and Strava Members page after updating to version 0.4.0.

## Version 0.5.0: incomplete reports
Reports with a group code or Strava link but no embedded Activity are sent separately to `/api/extension/posts`. They never become scoreable activities and never inherit steps from their title. Post IDs are distinct from Activity IDs. After a post is edited and a linked activity is successfully imported, re-crawling reconciles its report. Visible post headers supplement missing feed author metadata; records without a reliable author ID stay local and are counted in delivery details. Reload the unpacked extension and Strava tab, then choose **Lấy mới** to collect older posts with author metadata.

## Version 0.6.0: discussion kudos
Reads `post.kudos_count` and `post.originator_name` (verified against an exported feed and the visible discussion count). Counts belong to the post author, never an attached activity's athlete. Zero is retained, absent/invalid counts remain unknown. Every fetched entry records its observation time; saved data uses the checkpoint time as fallback. Re-crawling sends current post snapshots, including acknowledged posts whose count changed. The server deduplicates Post IDs, ignores older observations and never modifies review status or competition points. Reload the extension and Strava tab, then choose **Lấy mới**.

### Discussion photos (0.7.0)

Post snapshots include up to 10 direct `post.photos` images (`media_type=1`), with a 100px thumbnail, 1800px image URL, ID and caption. Only HTTPS URLs on the observed Strava image CDN are accepted. Missing `photos` preserves existing media; a known empty array clears it. Videos and images inside attached activities are not imported. Media is included in delivery fingerprints and post batches are bounded by both row count and payload size.

### Activity photos (0.8.0)

Activity rows now include attachment `media` photos and their observation timestamp. `Photo` media is normalized separately from post photos; videos are excluded. Media fingerprints allow acknowledged activities to be sent again when photos change. The server updates only dedicated media columns for duplicate activity IDs, preserving reviewed steps, status, points, attribution and revision. Older media snapshots are ignored; an empty current array removes photos.

## 0.9.0 — reconcile deleted posts

After a complete crawl and all uploads succeed, the extension sends every observed raw Post ID (including posts that cannot be normalized) to `/api/extension/posts/complete`. Missing unresolved reports are hidden from **Cần bổ sung**, with their records and scan history retained. Reappearing reports are restored on a later complete crawl. Partial/failed crawls never hide reports; failed finalization can be retried with **Gửi lại**. Older saved runs cannot override a newer completed scan. Approved activities, scores, and Top Kudo are unchanged. Reload the extension and Strava tab, then choose **Lấy mới** (or **Gửi lại** for an already complete saved crawl).
