const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return relative;
    }
}

// -----------------------------
// COOKIE STORAGE (basic per request)
// -----------------------------
function forwardCookies(req) {
    return req.headers.cookie || "";
}

// -----------------------------
// MAIN PROXY ROUTE
// -----------------------------
app.get("/proxy", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.send("No URL provided");

    try {
        const response = await axios.get(target, {
            responseType: "text",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Cookie": forwardCookies(req)
            }
        });

        const $ = cheerio.load(response.data);

        // -----------------------------
        // REWRITE LINKS (navigation)
        // -----------------------------
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href && !href.startsWith("javascript:")) {
                $(el).attr(
                    "href",
                    "/proxy?url=" + resolveUrl(target, href)
                );
            }
        });

        // -----------------------------
        // IMAGES
        // -----------------------------
        $("img").each((_, el) => {
            const src = $(el).attr("src");
            if (src) {
                $(el).attr(
                    "src",
                    "/asset?url=" + resolveUrl(target, src)
                );
            }
        });

        // -----------------------------
        // SCRIPTS
        // -----------------------------
        $("script[src]").each((_, el) => {
            const src = $(el).attr("src");
            if (src) {
                $(el).attr(
                    "src",
                    "/asset?url=" + resolveUrl(target, src)
                );
            }
        });

        // -----------------------------
        // CSS FILES
        // -----------------------------
        $("link[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (href) {
                $(el).attr(
                    "href",
                    "/asset?url=" + resolveUrl(target, href)
                );
            }
        });

        // -----------------------------
        // FIX INLINE CSS url(...)
        // (THIS is a BIG v3 upgrade)
        // -----------------------------
        $("style").each((_, el) => {
            let css = $(el).html();

            css = css.replace(/url\(["']?(.*?)["']?\)/g, (match, p1) => {
                const fixed = resolveUrl(target, p1);
                return `url("/asset?url=${fixed}")`;
            });

            $(el).html(css);
        });

        // -----------------------------
        // BASE TAG (fix relative navigation)
        // -----------------------------
        $("head").prepend(`<base href="${target}">`);

        res.send($.html());

    } catch (err) {
        res.send("Proxy error loading page");
    }
});

// -----------------------------
// ASSET PROXY (images/css/js/etc)
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

        const contentType = response.headers["content-type"];
        res.setHeader("Content-Type", contentType);

        res.send(response.data);

    } catch (err) {
        res.send("Asset error");
    }
});

app.listen(PORT, () => {
    console.log("V3 Proxy Engine running on port " + PORT);
});
