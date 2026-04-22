const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const urlLib = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return relative;
    }
}

// ------------------------
// MAIN PROXY HTML ROUTE
// ------------------------
app.get("/proxy", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.send("No URL provided");

    try {
        const response = await axios.get(target, {
            responseType: "text",
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        const $ = cheerio.load(response.data);

        // Rewrite ALL links
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href) {
                $(el).attr(
                    "href",
                    "/proxy?url=" + resolveUrl(target, href)
                );
            }
        });

        // Rewrite images
        $("img").each((_, el) => {
            const src = $(el).attr("src");
            if (src) {
                $(el).attr(
                    "src",
                    "/asset?url=" + resolveUrl(target, src)
                );
            }
        });

        // Rewrite scripts
        $("script[src]").each((_, el) => {
            const src = $(el).attr("src");
            if (src) {
                $(el).attr(
                    "src",
                    "/asset?url=" + resolveUrl(target, src)
                );
            }
        });

        // Rewrite CSS files
        $("link[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (href) {
                $(el).attr(
                    "href",
                    "/asset?url=" + resolveUrl(target, href)
                );
            }
        });

        // Inject base tag (helps relative navigation)
        $("head").prepend(`<base href="${target}">`);

        res.send($.html());

    } catch (err) {
        res.send("Error loading page");
    }
});

// ------------------------
// ASSET PROXY (images/css/js)
// ------------------------
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
        res.send("Asset load error");
    }
});

app.listen(PORT, () => {
    console.log("V2 Proxy running on port " + PORT);
});
