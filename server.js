const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// SIMPLE SESSION STORE (RAM)
// -----------------------------
const sessions = {};

// create or get session
function getSession(req) {
    let sid = req.headers["x-session-id"];

    if (!sid) {
        sid = crypto.randomBytes(8).toString("hex");
    }

    if (!sessions[sid]) {
        sessions[sid] = {
            cookies: ""
        };
    }

    return { sid, session: sessions[sid] };
}

// resolve URLs
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return relative;
    }
}

// -----------------------------
// MAIN PROXY
// -----------------------------
app.get("/proxy", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.send("No URL provided");

    const { sid, session } = getSession(req);

    try {
        const response = await axios.get(target, {
            responseType: "text",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Cookie": session.cookies
            }
        });

        const $ = cheerio.load(response.data);

        // -----------------------------
        // COOKIE CAPTURE (basic)
        // -----------------------------
        const setCookie = response.headers["set-cookie"];
        if (setCookie) {
            session.cookies = setCookie.map(c => c.split(";")[0]).join("; ");
        }

        // -----------------------------
        // LINK REWRITE
        // -----------------------------
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href && !href.startsWith("javascript:")) {
                $(el).attr(
                    "href",
                    `/proxy?url=${resolveUrl(target, href)}`
                );
            }
        });

        // -----------------------------
        // ASSETS
        // -----------------------------
        $("img, script, link").each((_, el) => {
            const attr = $(el).attr("src") || $(el).attr("href");
            if (attr) {
                const fixed = resolveUrl(target, attr);
                const proxyUrl = `/asset?url=${fixed}`;

                if ($(el).attr("src")) $(el).attr("src", proxyUrl);
                if ($(el).attr("href")) $(el).attr("href", proxyUrl);
            }
        });

        // -----------------------------
        // CSS url() FIX
        // -----------------------------
        $("style").each((_, el) => {
            let css = $(el).html();

            css = css.replace(/url\(["']?(.*?)["']?\)/g, (m, p1) => {
                return `url("/asset?url=${resolveUrl(target, p1)}")`;
            });

            $(el).html(css);
        });

        // -----------------------------
        // BASE TAG
        // -----------------------------
        $("head").prepend(`<base href="${target}">`);

        // -----------------------------
        // 🔥 INJECT CLIENT SCRIPT (IMPORTANT V4 FEATURE)
        // -----------------------------
        $("body").append(`
<script>
(function() {
    const origFetch = window.fetch;

    window.fetch = function(...args) {
        let url = args[0];

        if (typeof url === "string") {
            if (!url.startsWith("/proxy") && !url.startsWith("http")) {
                url = "/proxy?url=" + encodeURIComponent(new URL(url, location.href).href);
            }
        }

        return origFetch(url, ...args.slice(1));
    };

    // Fix SPA navigation (basic)
    const origPush = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) {
            location.href = "/proxy?url=" + encodeURIComponent(new URL(url, location.href).href);
        }
    };
})();
</script>
        `);

        res.setHeader("x-session-id", sid);
        res.send($.html());

    } catch (err) {
        res.send("Proxy error");
    }
});

// -----------------------------
// ASSET PROXY (v4 improved)
// -----------------------------
app.get("/asset", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.send("No asset URL");

    try {
        const response = await axios.get(target, {
            responseType: "arraybuffer",
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        res.setHeader("Content-Type", response.headers["content-type"]);
        res.send(response.data);

    } catch (err) {
        res.send("Asset error");
    }
});

app.listen(PORT, () => {
    console.log("V4 Proxy Engine running on port " + PORT);
});
