const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const urlLib = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

// helper
function resolveUrl(base, relative) {
return urlLib.resolve(base, relative);
}

// main proxy
app.get("/proxy", async (req, res) => {
const target = req.query.url;
if (!target) return res.send("No URL provided");

try {
const response = await axios.get(target, {
responseType: "text",
headers: { "User-Agent": "Mozilla/5.0" }
});

const $ = cheerio.load(response.data);

// rewrite links
$("a").each((_, el) => {
let href = $(el).attr("href");
if (href) {
$(el).attr(
"href",
"/proxy?url=" + resolveUrl(target, href)
);
}
});

res.send($.html());

} catch (err) {
res.send("Error loading page");
}
});

app.listen(PORT, () => {
console.log("Proxy running on port " + PORT);
});