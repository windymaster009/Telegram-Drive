import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ShareLinkHost } from "./components/dashboard/ShareLinkHost";
import { PublicSharePageV2 } from "./components/share/PublicSharePageV2";
import "./mobile-polish.css";
import "./public-share.css";

const params = new URLSearchParams(window.location.search);
const queryShareToken = params.get("share");
const pathMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
const pathShareToken = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
const shareToken = queryShareToken || pathShareToken;

document.body.classList.toggle("public-share-mode", Boolean(shareToken));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {shareToken ? (
      <PublicSharePageV2 token={shareToken} />
    ) : (
      <>
        <App />
        <ShareLinkHost />
      </>
    )}
  </React.StrictMode>,
);
