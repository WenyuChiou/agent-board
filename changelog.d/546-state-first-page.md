- **Page / Needs you first, then what is moving** · The page opens on what needs you, then what is working now, then your projects, with a closed shelf of finished work at the end. Every card and row carries its agent's mark, one row of agent icons filters the page to one agent, and the old agent grouping and the paste-from-web-chat box are gone, so a web chat's report arrives as a progress block like any other agent's. An empty board lists the agents that can report to it and how their work will appear. An agent with no open session shows as offline, and its answers say they are copied, with where to paste them. A sent message shows sending, then the reply or what failed with Send again, and a sent answer stops counting as waiting for you. progress.html follows the same order, and nothing on the page runs past the screen edge on a phone (#546).
  Tests: `the page opens on Needs you, then Working now, then projects, with each card's agent mark`,
  `the agent row shows each agent's counts and filters the page to that agent`,
  `the old agent address opens the default page`,
  `progress.html follows the page's order`,
  `a reply button on an unconnected question says it copies and the card then says where to paste it`,
  `the empty page lists the connected agents and how their work appears`,
  `a sent message shows sending, then the reply or a failure with Send again`,
  `a sent answer stops counting as waiting for you`,
  `an agent with no open session shows as offline and its answers copy`,
  `at phone widths nothing on the page runs past its edge`.
- **Page / Sidebar on wide screens** · From a narrow docked window up, a sidebar lists the views, the agents and the projects with their counts; it folds to a rail of icons and back, and a project and an agent filter work together. The tab title, the Needs you flag, the agent badges and the sidebar always show the same count. Buttons keep their desktop size with a mouse, even in a narrow window (#546).
  Tests: `on a wide screen the sidebar lists views, agents and projects`,
  `picking a view shows only that section`,
  `a project and an agent filter combine`,
  `a project in the sidebar counts its questions, working tasks and other work, and leaves its stopped and finished tasks out`,
  `the tab title, the Needs you flag, the agent badges and the sidebar show the same count`,
  `a filter or a view press keeps hidden-question and recent-action results beside their controls`,
  `one press on an agent shows only that agent's work, and a refresh keeps its draft and open rows`,
  `the sidebar and the theme button keep working while the board is unreachable`,
  `the sidebar folds to a rail at the docked width`,
  `buttons keep desktop size in a narrow window with a mouse`.
- **Page / Calmer colours and a simpler footer** · Actions are ink and only what needs you is amber; green means alive and red means something is wrong. Light and dark are one icon button, the tab and heading say Agent Board, the footer shows the version as a link to the project next to Close board, and the motion stops under reduced motion while every change still lands (#546).
  Tests: `the page uses ink for actions and amber only for what needs you`,
  `the serve page offers a light and a dark theme, follows the system until one is picked, and remembers the choice`,
  `the footer links to the project`,
  `the page's motion stops under reduced motion and every change still lands`.
