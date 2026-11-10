// jzhao.xyz 스타일 보조 플러그인
// 1) 한글 웹폰트(Noto Serif KR, IBM Plex Sans KR, Nanum Pen Script)를 모든 페이지에 불러온다
// 2) 홈(index)에만 나뭇잎 그림자 배너 자리(.dappled-scene)를 넣고, 그리는 스크립트를 붙인다
//    배너 코드: https://github.com/jackyzha0/jackyzha0.github.io (MIT, Jacky Zhao)
import { readFileSync } from "node:fs"

const dappledScript = readFileSync(new URL("./dappled.js", import.meta.url), "utf8")

const FONTS =
  "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;700&family=IBM+Plex+Sans+KR:wght@400;600;700&family=Nanum+Pen+Script&display=swap"

function rehypeDappledBanner() {
  return (tree, file) => {
    if (file.data?.slug !== "index") return
    tree.children.unshift({
      type: "element",
      tagName: "div",
      properties: { className: ["dappled-scene"], ariaHidden: "true" },
      children: [],
    })
  }
}

export default function JzStyle() {
  return {
    name: "JzStyle",
    htmlPlugins() {
      return [rehypeDappledBanner]
    },
    externalResources() {
      return {
        css: [{ content: FONTS }],
        js: [{ script: dappledScript, loadTime: "afterDOMReady", contentType: "inline", moduleType: "module" }],
      }
    },
  }
}
