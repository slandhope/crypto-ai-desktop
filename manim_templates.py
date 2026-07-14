# ═══════════════════════════════════════════════════════════════════
# 🎬 ASUKA VIDEO LESSONS — Manim template library
# Renders a lesson from spec.json sitting in the same directory.
# Claude fills the spec; these templates guarantee it compiles.
# No LaTeX needed — equations render as styled Text (Pango).
# Render: python3 -m manim -qm --disable_caching manim_templates.py Lesson
# ═══════════════════════════════════════════════════════════════════
import json, os, math
from manim import *

SPEC_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spec.json")

ACCENT = "#2dd4ff"
WARM = "#f3a8d0"
GOOD = "#34d399"
BAD = "#fb7185"
INK = "#f4f5fb"
BG = "#0a0c16"

SAFE_FUNCS = {k: getattr(math, k) for k in ["sin","cos","tan","exp","log","sqrt","fabs","atan","asin","acos","sinh","cosh","tanh","pi","e"]}

def safe_fn(expr):
    def f(x):
        try:
            return float(eval(expr, {"__builtins__": {}}, dict(SAFE_FUNCS, x=x, abs=abs, min=min, max=max)))
        except Exception:
            return 0.0
    return f

class Lesson(Scene):
    def construct(self):
        self.camera.background_color = BG
        with open(SPEC_PATH) as f:
            spec = json.load(f)

        for sc in spec.get("scenes", []):
            t = sc.get("type", "")
            dur = float(sc.get("duration", 5))
            try:
                if t == "title":
                    self.scene_title(sc, dur)
                elif t == "equation":
                    self.scene_equation(sc, dur)
                elif t == "bullets":
                    self.scene_bullets(sc, dur)
                elif t == "graph":
                    self.scene_graph(sc, dur)
                elif t == "diagram":
                    self.scene_diagram(sc, dur)
                elif t == "compare":
                    self.scene_compare(sc, dur)
                else:
                    self.wait(min(dur, 2))
            except Exception:
                # a single bad scene must never kill the whole render
                self.clear_all()
                self.wait(1)

    # ── helpers ──────────────────────────────────────────────
    def clear_all(self):
        if self.mobjects:
            self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.5)

    def hold(self, dur, used):
        self.wait(max(0.5, dur - used))
        self.clear_all()

    # ── scene: big title + subtitle ─────────────────────────
    def scene_title(self, sc, dur):
        title = Text(str(sc.get("title", ""))[:60], color=INK, weight=BOLD).scale(0.9)
        self.play(Write(title), run_time=1.4)
        used = 1.4
        if sc.get("subtitle"):
            sub = Text(str(sc["subtitle"])[:80], color=ACCENT).scale(0.45)
            sub.next_to(title, DOWN, buff=0.5)
            self.play(FadeIn(sub, shift=UP * 0.3), run_time=0.8)
            used += 0.8
        self.hold(dur, used)

    # ── scene: equation with term explanations ──────────────
    def scene_equation(self, sc, dur):
        eq = Text(str(sc.get("equation", ""))[:40], color=INK, weight=BOLD, font="Menlo").scale(1.1)
        self.play(Write(eq), run_time=1.5)
        used = 1.5
        terms = sc.get("terms", [])[:4]
        if terms:
            self.play(eq.animate.to_edge(UP, buff=1.0), run_time=0.6)
            used += 0.6
            rows = VGroup()
            for term in terms:
                sym = Text(str(term.get("symbol", ""))[:6], color=ACCENT, weight=BOLD, font="Menlo").scale(0.6)
                mean = Text("= " + str(term.get("means", ""))[:48], color=INK).scale(0.45)
                row = VGroup(sym, mean).arrange(RIGHT, buff=0.3)
                rows.add(row)
            rows.arrange(DOWN, aligned_edge=LEFT, buff=0.35).next_to(eq, DOWN, buff=0.8)
            for row in rows:
                self.play(FadeIn(row, shift=RIGHT * 0.3), run_time=0.6)
                used += 0.6
        self.hold(dur, used)

    # ── scene: heading + bullet points ───────────────────────
    def scene_bullets(self, sc, dur):
        used = 0
        if sc.get("heading"):
            h = Text(str(sc["heading"])[:60], color=WARM, weight=BOLD).scale(0.6).to_edge(UP, buff=0.8)
            self.play(Write(h), run_time=0.8)
            used += 0.8
        pts = VGroup()
        for p in sc.get("points", [])[:5]:
            dot = Text("•", color=ACCENT).scale(0.5)
            txt = Text(str(p)[:70], color=INK).scale(0.42)
            pts.add(VGroup(dot, txt).arrange(RIGHT, buff=0.25))
        pts.arrange(DOWN, aligned_edge=LEFT, buff=0.4).shift(DOWN * 0.3)
        for p in pts:
            self.play(FadeIn(p, shift=UP * 0.2), run_time=0.55)
            used += 0.55
        self.hold(dur, used)

    # ── scene: function graph ────────────────────────────────
    def scene_graph(self, sc, dur):
        xr = sc.get("x_range", [-4, 4])
        yr = sc.get("y_range", [-3, 3])
        ax = Axes(x_range=[xr[0], xr[1], 1], y_range=[yr[0], yr[1], 1],
                  x_length=8, y_length=5,
                  axis_config={"color": "#3a4258", "include_tip": True}).shift(DOWN * 0.2)
        self.play(Create(ax), run_time=1.0)
        used = 1.0
        if sc.get("title"):
            t = Text(str(sc["title"])[:50], color=WARM, weight=BOLD).scale(0.5).to_edge(UP, buff=0.5)
            self.play(FadeIn(t), run_time=0.5)
            used += 0.5
        colors = [ACCENT, GOOD, BAD]
        for i, cv in enumerate(sc.get("curves", [])[:3]):
            fn = safe_fn(str(cv.get("expr", "x")))
            g = ax.plot(fn, x_range=[xr[0], xr[1]], color=colors[i % 3], use_smoothing=True)
            self.play(Create(g), run_time=1.4)
            used += 1.4
            if cv.get("label"):
                lb = Text(str(cv["label"])[:24], color=colors[i % 3]).scale(0.4)
                lb.next_to(ax, DOWN, buff=0.3).shift(RIGHT * (i * 2.6 - 2.6))
                self.play(FadeIn(lb), run_time=0.4)
                used += 0.4
        self.hold(dur, used)

    # ── scene: labeled boxes with arrows (flow diagram) ─────
    def scene_diagram(self, sc, dur):
        used = 0
        if sc.get("title"):
            t = Text(str(sc["title"])[:50], color=WARM, weight=BOLD).scale(0.5).to_edge(UP, buff=0.5)
            self.play(Write(t), run_time=0.7)
            used += 0.7
        nodes = sc.get("nodes", [])[:4]
        boxes = VGroup()
        for n in nodes:
            label = Text(str(n)[:22], color=INK).scale(0.42)
            box = RoundedRectangle(corner_radius=0.15, width=label.width + 0.7, height=0.9,
                                   stroke_color=ACCENT, fill_color="#141a28", fill_opacity=1)
            boxes.add(VGroup(box, label))
        boxes.arrange(RIGHT, buff=1.1).shift(DOWN * 0.2)
        if boxes.width > 12:
            boxes.scale_to_fit_width(12)
        for i, b in enumerate(boxes):
            self.play(FadeIn(b, shift=UP * 0.2), run_time=0.5)
            used += 0.5
            if i > 0:
                a = Arrow(boxes[i-1].get_right(), b.get_left(), color=WARM, buff=0.08, stroke_width=3)
                self.play(Create(a), run_time=0.35)
                used += 0.35
        self.hold(dur, used)

    # ── scene: two-column comparison ─────────────────────────
    def scene_compare(self, sc, dur):
        used = 0
        if sc.get("title"):
            t = Text(str(sc["title"])[:50], color=WARM, weight=BOLD).scale(0.5).to_edge(UP, buff=0.5)
            self.play(Write(t), run_time=0.7)
            used += 0.7
        def col(head, items, color, shift_x):
            h = Text(str(head)[:24], color=color, weight=BOLD).scale(0.5)
            g = VGroup(h)
            for it in items[:4]:
                g.add(Text(str(it)[:34], color=INK).scale(0.38))
            g.arrange(DOWN, aligned_edge=LEFT, buff=0.32).shift(RIGHT * shift_x + DOWN * 0.2)
            return g
        left = col(sc.get("left_title", "A"), sc.get("left", []), GOOD, -3.2)
        right = col(sc.get("right_title", "B"), sc.get("right", []), BAD, 3.2)
        div = Line(UP * 2, DOWN * 2.4, color="#3a4258")
        self.play(Create(div), run_time=0.4); used += 0.4
        self.play(FadeIn(left, shift=RIGHT * 0.3), run_time=0.7); used += 0.7
        self.play(FadeIn(right, shift=LEFT * 0.3), run_time=0.7); used += 0.7
        self.hold(dur, used)
