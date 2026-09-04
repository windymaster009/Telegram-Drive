import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ShareLinkHost } from "./components/dashboard/ShareLinkHost";
import { PublicSharePage } from "./components/share/PublicSharePage";
import "./mobile-polish.css";

const params = new URLSearchParams(window.location.search);
const queryShareToken = params.get("share");
const pathMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
const pathShareToken = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
const shareToken = queryShareToken || pathShareToken;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {shareToken ? (
      <PublicSharePage token={shareToken} />
    ) : (
      <>
        <App />
        <ShareLinkHost />
      </>
    )}
  </React.StrictMode>,
);
