import sharp from "sharp";
import Tesseract from "tesseract.js";

async function main() {
  const png = await sharp({
    create: {
      width: 160,
      height: 48,
      channels: 3,
      background: "#ffffff",
    },
  })
    .png()
    .toBuffer();
  const { data } = await Tesseract.recognize(png, "eng", { logger: () => {} });
  console.log("tesseract ok", JSON.stringify(data.text));
}

main();
