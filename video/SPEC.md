GOAL:    A developer sees their own leaked `.env` in the first second, then watches each PII span get blacked out on the machine, and ends believing the gate is real, not marketing.
OUTPUT:  HyperFrames, 1920x1080, 30 fps
TIME:    13s = 390 frames. No music; cuts land on scene logic, not a beat.

LOOK:    Ground: warm cream paper #F2EDE1, flat fill with 3% procedural grain (no gradient — H.264 bands).
         Ink: near-black #17140F. Redaction bars are the same ink, solid, 0 blur.
         Accent: oxide red #B5342A — appears on exactly one thing per shot: the "0" hero and the
         counter's last tick. Nothing else is red.
         Display face: Archivo Black, tracking -2%, sizes 132px (hero counters), 54px (statements).
         Data face: IBM Plex Mono 400/600, 26px, tracking 0 — file names, spans, terminal line.
         Medium: paper documents on a formica desk; ink and paper only. Documents are real
         rectangles with a 1.5% page-drop shadow (offset 0 18px, blur 44px, ink @ 12%),
         each sheet 2-3px off-axis so the pile reads as paper, not as cards.
         Light: flat overhead, one 6% vignette, no glow, no bloom, no gradients.
OBJECTS: A page (cream rectangle, ink rules); a redaction bar (solid ink rectangle, 0 radius, slams
         down over a span); a document strip (three stacked pages with mono lines); the gate
         (a vertical ink rule that sweeps across, splitting "on device" from "cloud");
         the counter (Archivo Black numerals in mono-aligned boxes).
MOTION:  Entrances: power4.out, 0.34s. Bars slam: power3.in 0.16s, no bounce, no fade.
         Gate sweep: power2.inOut 0.5s. Exits are 0.16s, blur-out 6px, word by word.
         Stagger: file lines 70ms, bars 55ms, letters of the hero number 25ms.
         No breathing, no floating, no pulsing. A landed title is dead still.
SHOTS:   1. 0.0-2.8s  HOOK. Split frame: left = a page with a live `.env` (real keys visible),
                        right = the same page after. Mono line "15 planted." stamps in at 0.5s;
                        "0 leaked." lands at 1.7s with the "0" in oxide red. One hero move:
                        the right page slides 40px left as its spans turn to ink bars.
         2. 2.8-6.6s  THE PILE. Three document strips (bank, medical, ticket) slide up in
                        120ms stagger; each PII span takes a solid bar, 55ms apart, 15 bars total;
                        the counter in the corner ticks 1..15 in mono. The page edges darken 4%
                        as bars land (paper absorbing ink).
         3. 6.6-9.6s  THE GATE. One page sits centre; a vertical ink rule sweeps left-to-right
                        across it (0.5s). Left of the rule the text stays; right of it the text
                        is replaced by solid bars. Caption: "the scan runs on your machine".
         4. 9.6-11.6s THE RESULT. Everything wipes to bare paper in 0.2s. "0" fills 62% of the
                        frame height in oxide red, "leaked" in Archivo Black below it, mono line
                        under it: "15 planted. 115 spans. 0 sent."
         5. 11.6-13.0s END CARD. Mono: "pi install npm:pi-privacy-gate" — types on, 22ms a char,
                        then holds dead still. Cream ground, black type, nothing else.

BANNED:  dark void and glow; centered floating text in a gradient; per-scene fade+slide-up;
         Inter / Space Grotesk / Geist / JetBrains Mono; breathing loops on titles; glassmorphism;
         a terminal-window mockup with traffic-light dots; "AI" badges, neural-net webbing,
         shield icons; stock footage of a hacker in a hoodie; any padlock glyph.
QA:      frame 45 (hook readable at a glance: 15 planted / 0 leaked);
         frame 150 (bars landed on all three strips, counter at 15);
         frame 245 (gate rule visible mid-page, split legible);
         frame 320 (the "0" hero, oxide red, >60% frame height);
         frame 385 (install line, dead still, legible).
