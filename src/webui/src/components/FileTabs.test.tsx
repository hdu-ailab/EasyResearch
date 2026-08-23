import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { type FileTab, FileTabs } from "./FileTabs";

const initialTabs: FileTab[] = [
  { path: "/a.md", name: "a.md" },
  { path: "/b.md", name: "b.md" },
  { path: "/c.md", name: "c.md" },
];

function Harness({ onClose }: { onClose: (path: string) => void }) {
  const [tabs, setTabs] = useState(initialTabs);
  const [active, setActive] = useState("/a.md");
  return (
    <FileTabs
      tabs={tabs}
      active={active}
      onActivate={setActive}
      onClose={(path) => {
        onClose(path);
        setTabs((current) => {
          const index = current.findIndex((tab) => tab.path === path);
          const next = current.filter((tab) => tab.path !== path);
          setActive((selected) =>
            selected === path ? (next[Math.min(index, next.length - 1)]?.path ?? "") : selected,
          );
          return next;
        });
      }}
    />
  );
}

it("uses one roving tab stop and supports arrow, boundary, and Delete keys", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  const tab = (name: string) => screen.getByRole("tab", { name });

  expect(tab("a.md")).toHaveAttribute("tabindex", "0");
  expect(tab("b.md")).toHaveAttribute("tabindex", "-1");
  tab("a.md").focus();
  await user.keyboard("{ArrowRight}");
  expect(tab("b.md")).toHaveFocus();
  expect(tab("b.md")).toHaveAttribute("aria-selected", "true");

  await user.keyboard("{End}");
  expect(tab("c.md")).toHaveFocus();
  await user.keyboard("{Home}");
  expect(tab("a.md")).toHaveFocus();
  await user.keyboard("{Delete}");

  expect(onClose).toHaveBeenCalledWith("/a.md");
  expect(screen.queryByRole("tab", { name: "a.md" })).toBeNull();
  expect(tab("b.md")).toHaveFocus();
});

it("returns focus to the tree toggle after closing the last tab", async () => {
  const user = userEvent.setup();
  function SingleTab() {
    const [open, setOpen] = useState(true);
    return (
      <FileTabs
        tabs={open ? [initialTabs[0]!] : []}
        active={open ? "/a.md" : null}
        onActivate={() => {}}
        onClose={() => setOpen(false)}
        toggle={{ opened: true, onToggle: () => {} }}
      />
    );
  }
  render(<SingleTab />);
  screen.getByRole("tab", { name: "a.md" }).focus();

  await user.keyboard("{Delete}");

  expect(screen.getByRole("button", { name: /toggle file tree/i })).toHaveFocus();
});
