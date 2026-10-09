import { connect } from "@alto-rooms/plugin-sdk";
import { createRoot } from "react-dom/client";
import { HighlightList } from "./HighlightList";
import "./styles.css";

const rooms = await connect();
createRoot(document.getElementById("root")!).render(<HighlightList rooms={rooms} />);
