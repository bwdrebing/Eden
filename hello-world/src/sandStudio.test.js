import { render, screen, fireEvent, act } from "@testing-library/react";
import App from "./App";
import { readSlice } from "./urlSettings";
import { SAND_WORKSPACES } from "./SandscapeStudio";

// The water studio is the default, and every link from before the sand
// studio existed has no "app" slice — it must keep opening on the water.
test("opens on the water studio, and the switch opens the sand studio", async () => {
  render(<App />);
  expect(screen.getByText(/reflection region studio/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /sand/i }));
  expect(screen.getByText(/sandscape studio/i)).toBeInTheDocument();
  expect(readSlice("app").studio).toBe("sand");

  // the preview arrives (inline here: jsdom has no workers) as the export's
  // own SVG string
  const pic = await screen.findByTestId("sand-preview", {}, { timeout: 30000 });
  expect(pic.innerHTML.startsWith("<svg")).toBe(true);

  // one tab per workspace, and each opens its own panel
  for (const w of SAND_WORKSPACES) {
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(w.name, "i") }));
    expect(screen.getByRole("tab", { name: new RegExp(w.name, "i") })).toHaveAttribute("aria-selected", "true");
  }
  fireEvent.click(screen.getByRole("tab", { name: /light/i }));
  expect(screen.getByText(/sun height/i)).toBeInTheDocument();

  // a starting point reshapes the scene: wind ripples are seen from above
  fireEvent.click(screen.getByRole("tab", { name: /terrain/i }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Wind ripples" })); });
  fireEvent.click(screen.getByRole("tab", { name: /camera/i }));
  expect(screen.getByText(/width across the frame/i)).toBeInTheDocument();

  // and the scene rides in the URL
  const slice = readSlice("sand");
  expect(slice.view).toBe("plan");
  expect(slice.features.map((f) => f.type)).toEqual(["wind"]);
}, 60000);

test("every sand control named in the find index is under a real workspace", () => {
  const ids = new Set(SAND_WORKSPACES.map((w) => w.id));
  expect(ids.size).toBe(SAND_WORKSPACES.length);
  for (const w of SAND_WORKSPACES) expect(w.find.length).toBeGreaterThan(2);
});
