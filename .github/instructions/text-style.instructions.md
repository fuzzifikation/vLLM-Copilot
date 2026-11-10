---
name: Text Style
description: "Prose law for all text a human reads, AI replies and reasoning included: point before detail, actors as subjects, short subjects with early verbs, cut filler, one name per thing, references that resolve, structure follows length. Not for code."
applyTo: "**/*.md,**/*.tex,**/*.rst,**/*.txt"
---

<!-- vendored from fuzzifikation/agents @ af27812, synced 2026-11-10. Do not edit here: edit upstream and re-run bin/sync.ps1 -->

# Text Style

Good prose leaves a skimming reader correct and never bores a careful one. The reader should never ask "what is going on" while holding your words in memory: the point comes first, the details follow. This law applies to anything a human reads: docs, READMEs, changelogs, design docs, papers, lecture notes, commit messages, and every AI reply, reasoning included. The `applyTo` globs below only tell an editor when to attach the file; they do not bound the law. Code obeys the simplicity laws WP30–WP36 in `working-principles.instructions.md`. A project may add an overlay that tightens these rules; it may not loosen them.

Voice: dry, direct, mean about the engineering, never about the reader.

Rules sit near their topic, numbered in reading order. Renumber the whole list whenever it changes, moving every cross-reference in the same edit. Git holds what was and why; the file never carries history.

Readers recall the law as eight invariants. The numbered rules are their consequences: lookup, not memory. A rule that cannot be tagged to an invariant gets cut.

* **Say something new or get cut.** Every sentence adds information, consequence, or example. (rules 1, 2, 3, 20, 21)
* **Say it once.** A claim is stated in full where it is established; every later appearance is a pointer. (rules 8, 9, 10)
* **Design the positions.** First position says what the sentence is about, last position what the reader must keep, and the main point precedes its exceptions. (rules 7, 16, 17, 22, 26, 27)
* **Actors act, in the subject's words.** People and things as subjects, actions as verbs; images stay single and unexplained; analogies introduce themselves. (rules 5, 6, 18, 23, 25)
* **One name, one meaning.** Every reference resolves to one named thing; comparisons join matching types. (rules 11, 12, 13, 14, 15, 24)
* **Assertions carry their support.** Conditions stated, sources named, or the claim goes. (rules 4, 19)
* **Structure follows length.** The skim path leaves a correct model; openings and closings match the size of the unit. (rules 33–37)
* **Reading is the audit.** Machines list candidates; a rereader who is not the writer decides; replies are docs like files. (rules 28–32)

## 1 Cut on sight

1. **No two sentences with the same meaning.** When two consecutive sentences say the same thing, cut one; keep the clearer. “In other words”, “This means” and “That is” flag the test but do not decide it: “Run `umixer check --strict`. This means CI fails on the first schema drift.” stays, because the second sentence adds a consequence the first does not spell out. A sentence must add information, consequence, or example; one that adds none, delete.
2. **One rhetorical template per section.** “X alone does not establish Y”, “is not sufficient evidence”, “does not certify”, “not X - Y”, “not only X but also Y”, “it is not about X, it is about Y”: each shape once per section, maximum. Two identically shaped caveats read as machine text, even when both are true.
3. **No filler adjectives.** Banned: crucial, vital, key, powerful, robust (unless a term of art), significant/significantly (unless a statistical claim), seamless, inherent, pivotal, comprehensive, delve, leverage, showcase, underscore, facilitate, utilise, furthermore, moreover, notably, additionally, particularly, testament, landscape. A project's own terms of art are exempt: they name things.
4. **Hidden logic becomes explicit.** Where "often", "typically", "generally" or "usually" hides a testable condition, write the condition: when it holds, and when it does not. "While", "as" and "since" hide which relation holds (time or contrast); write the one that holds. If a sentence reports only states, it must name the decision or consequence that makes it worth stating; if it names none, delete it.
5. **One image per idea, and never explain it.**
6. **Stay in the subject's words; an analogy introduces itself.** Each subject has words it uses about itself; use those. In writing about writing these are: topic position, stress position, antecedent, hedge, register. "Punch", "pay rent", "has no mouth" are borrowed images, not terms of this subject. An analogy is legal when it helps the reader understand and the writer marks it: "as an analogy", "think of this like". An unmarked analogy pulls the reader out of the subject on every use; the mark tells the reader before the move.
7. **No em dashes; parentheses carry asides.** The em-dash aside is the giveaway of AI text (source 7 lists em-dash rhythm among the machine signs). Parentheses carry asides and examples, beside the word they clarify: an example after the wrong noun makes the reader rule out the wrong reading before learning anything. A colon introduces, a comma binds apposition, a full stop emphasizes; a full stop is not a personality flaw. When items carry their own commas, separate them with semicolons: a list whose second tier shares the first tier makes the reader re-parse at every "and". Max one colon per sentence. Ranges and dates keep the en dash (rules 33–37, 2015–2024).

## 2 Repetition

Unmarked repetition is a defect: the reader cannot tell emphasis from accident, and by the third copy the reader stops trusting the text.

8. **State a claim in full once per document**, where it is established. Later appearances are cross-references. Full restatement is legal in three places only: the summary at the top, the user-facing entry point, and the place of application. A warning gets its second full statement where it applies; two per document, maximum.
9. **Deliberate recaps announce themselves** with the project's marker ("(recall §2.4)", "(standing ruling)") so one grep lists every recap and each can be audited for earning its place.
10. **A recap must demand something.** Rereading is a demonstrably poor way to learn, and a prose recap demands nothing. Write pointer plus question: "The check is the one in §2.4. Which of the two inputs makes it fail, and why?"

## 3 Names

11. **No name before its meaning is available.** First use defines it in the same sentence or points at the definition. Symbols, identifiers, CLI flags, env vars and jargon alike.
12. **One name, one meaning.** Grep the project before introducing a name. If a second meaning needs it, move one of them.
13. **Same thing, same name.** "The actual regressor" does not become "the signal", then "the input", then "the driving term". Renaming one thing under several names for style is a fault in prose and a correctness bug in code.
14. **No names for one-use things.** Do not coin a term, macro, or named constant for something mentioned once; a name must add information or come back.
15. **Compare like with like.** A comparison joins two things of the same type: parameters with parameters, magnitudes with magnitudes, functions with functions. A mixed comparison shows itself as "uses X rather than doing Y". Fix the type, not the wording. "Before adjusting a controller online we ask what we would do with known parameters" → "Before adjusting a controller's parameters over time, we design a fixed-parameter controller for a known plant". A mixed comparison is a category error and belongs next to unit errors.

## 4 Sentences

16. **What the sentence is about first, what it says last.** Start with what the sentence is about; put the new fact, the part the reader must keep, at the end (Gopen and Swan: topic position, stress position). "The build fails, in the case where the flag is unset" → "With the flag unset, the build fails". If a trailing phrase tells the reader they misread what came before, move it to the front: "records every exchange twice, both server-side" → "keeps two server-side records of every exchange".
17. **Under ~25 words.** Go longer only when the dependency between the clauses is itself the content.
18. **Verbs, not nominalisations.** "We exploit", not "we make use of"; "the error converges", not "the error exhibits convergence". Passive voice only when the actor is genuinely irrelevant, and never "it is seen" without the by whom and the from what.
19. **No hand-waving words, no invisible authorities.** These phrases hide the argument or the authority: “Clearly”, “obviously”, “trivially”, “simply”, “easily”, “it can be shown”, “one can show”, “it is well known”, “studies show”, “experts argue”, “industry reports”. Carry the argument or name the source, or they go. In documentation they mark where the bug is.
20. **No "-ing" tails claiming significance.** "…, thereby ensuring consistency", "…, highlighting the need for care": cut, or give the consequence its own sentence.
21. **No padding structures.** Rule-of-three lists where two items serve; a hedging preamble followed by the assertion anyway. Endings belong to §6: short units close with nothing, long units with rule 35’s consolidation.
22. **Main point first, exceptions and qualifications after.** “We often omit $(t)$ from signals, but not their time dependence” → “We often omit $(t)$ from time-dependent signals”. A short condition may lead (rule 16). An exception the reader has not seen the rule for comes after the rule: “Except as described in (b), the review period starts when the submission is complete” → “The review period starts when the submission is complete; paragraph (b) holds an exception.” Several conditions in one sentence: split them into a list, each item one condition. Forbidden: a contradictory tail appended to a main clause (“X, but not Y”); chained relatives (“…, which is why …, which is what …”); any point that survives only if the reader keeps the subordinate clause. A hedge that carries information earns its own sentence; one that does not, delete.
23. **Abstractions do not act.** A discipline, theory, method, literature, objective, problem or definition cannot ask, want, argue, claim, wonder, admit, notice, decide or care. "Robust control asks whether the closed loop is stable" → "In robust control the engineer checks whether the closed loop is stable". Convert the field into a location (*in* robust control) or make its practitioners the actor. Legal subjects: people (the designer chooses; we assume); devices and signals (the controller saturates; the error converges); mathematical artifacts with logical predicates only (the theorem proves; the bound bounds; the condition rules out; the figure shows).
24. **A reference resolves to one named thing, of the right category.** Every pointing word owes this: `it`, `they`, `this`, `that`, `which`, `there`, `here`, `the latter`. (a) Two candidate antecedents: repeat the noun. "The text doesn't change", not "it doesn't change". (b) A demonstrative takes a noun ("this bound", "that choice"), never a bare "This is…". (c) A locative names its container, and the preposition matches that category: *in* a field, *in* a set, *in* an equation, *in* Case 4, *at* a frequency. "There the unknown parameters still matter" names no container, so the reader picks one. (d) After a display, never open with "Here $x$ is…". Name the display ("In \eqref{eq:PE}, $\succeq$ denotes…") or make the thing the subject ("The inequality $e_c^2\le2V_0$ follows from the Lyapunov bound"). (e) A sentence-level "…, which proves X" is legal only when the preceding clause is the sole possible referent. The sentence-relative "which" is the standard replacement for a bare "This is…", allowed, not an error. (f) Exempt: existential "there is/are" points nowhere, and so does the cleft "it is the error variable *that* has an equilibrium". Test before shipping: name the antecedent in three words. If you cannot, the sentence has no content and no synonym will give it one.
25. **Characters as subjects, actions as verbs.** "The designer chose a lower gain", not "a lower gain was chosen" and not "the choice of a lower gain was made". Williams's own term: zombie nouns (*the convergence of*, *the implementation of*) delete actor and action at once. Self-check twenty consecutive sentences: at least 70% must take a character as subject and at least 70% an action as main verb. Rule 18 cuts the nominalisation; this one supplies the missing actor.
26. **No long noun list as subject.** The verb comes within about five words of the subject; lists sit after the verb, never in front of it. "The plan, the decisions, the wire contract, the settings reference, and the structure rules all live here" forces the reader to hold five nouns in memory before learning what they do. That sentence passes rules 16 and 25 and still puts the list before its point. Fix: "This file is the whole plan. It covers the wire contract, the settings, and the structure." (Federal Plain Language Guidelines: keep the subject, verb, and object close together.)
27. **Every paragraph opens on its point, not on the document.** The first sentence states the paragraph’s point; a reader who skims only first sentences gets a correct, incomplete model of the section: rule 36’s skim test at paragraph scale. No document or section opens with “This file is…”, “This document discusses…”, “These notes cover…” Open on the thing itself: “Unified Mixers is one program that owns model traffic on machines you control.” A later line may speak about the document only when it carries a decision: “This file stays current; git holds the history.”

## 5 Process

28. **Reread as the reader, once, before sending.** For every changed paragraph: does the first sentence stand alone (rule 27), does the verb sit within a few words of the subject (rule 26), can you name each sentence's actor in three words (rule 25)? Reading load is the defect; greps cannot feel it, and the writer's own reread is weak evidence: the writer reads intention, not words. The rereader may not be the writer: a human, or a fresh agent let loose on the changed text with this rulebook, reads once before it ships. The rereader reports stumbles, not praise; the writer then repairs each stumble in a second pass.
29. **Replies are docs.** The law governs AI chat replies and reasoning exactly like files: the first sentence carries the point (rule 27), then the support. No sentence about your own previous message ("the mechanism answer stands as given"); no achievement lists about yourself; no clipped fragments standing in for content ("no theater, just work"). Brevity excuses nothing: an answer that fits in five sentences is five sentences, and those five still obey rules 26 and 27.
30. **Formatting is not content.** Chatbots fake structure with formatting: bold on every instance of a term, "Label: fact" bullets, Title Case headings, scattered headings (skipped levels, one-line sections), "Key takeaways" boxes, emoji. Prose carries conclusions. Use bullets only where items are truly parallel, tables where the reader compares or executes, and sentence case for headings.
31. **No manual line wraps.** You are not the editor; editors exist. A paragraph is one line: blank lines and headings break it, nothing else. Tables, command lists, code, and diagrams own their rows: one line per row, item, or entry, never re-wrapped by hand. Hand-wrapped source is permanent diff noise: it buries real changes under re-wraps in every future review.
32. **No chatbot residue.** Pleasantry is not text: “Certainly!”, “Great question”, “I hope this helps”, “let me know if you'd like…” cut on sight. Text does not narrate its own making (“I kept your wording”, “based on the provided sources”).

The pattern sweep below stays available as a quick machine pass for candidates under rules 1–3, 20, 23, and 25. It lists candidates, never verdicts; reading is the audit.

```sh
# grep 1
grep -rniE 'in other words|this means|it can be shown|it is well known|clearly|obvious|trivial|simply' --include='*.md' --include='*.tex' .
# grep 2
grep -rniE 'delve|showcas|underscor|crucial|vital|notably|additionally|particularly|comprehensive|leverag|facilitat|utiliz|pivotal|seamless|landscape|testament|significantly' --include='*.md' --include='*.tex' .
# grep 3
grep -rniE 'does not establish|not sufficient|not a proof|not certify|does not by itself|alone does not' --include='*.md' --include='*.tex' .
# grep 4
grep -rniE ', (ensuring|highlighting|underscoring|showcasing|demonstrating|indicating|reflecting|enabling|revealing)|not only|in summary|in conclusion|^overall|together, these|it is important' --include='*.md' --include='*.tex' .
# grep 5
grep -rniE '\b(control|theory|field|discipline|method|approach|framework|literature|objective|definition|problem|analysis|design|chapter|section)\s+(asks|wants|argues|claims|believes|knows|worries|cares|insists|admits|prefers|refuses|decides|settles|forgets|remembers|notes|observes)\b' --include='*.md' --include='*.tex' .
# grep 6
grep -rniE '(^|[.;:] )(This|That|These|Those)\s+(is|are|shows|proves|means|follows|fails|gives|makes|leaves|requires|explains|implies)|(^|[.;:] )It\s+(is|does|follows|holds|can|may|gives|needs|makes|costs)|(^|[.;:] )(There|Here)[,\s]' --include='*.md' --include='*.tex' .
# grep 7
grep -rniE '\b(the|this|that|a|an|its|our|their)\s+([a-z]+(tion|sion|ment|ance|ence|ing))\s+of\b' --include='*.md' --include='*.tex' .
```

Windows: `Select-String -Path *.md,*.tex -Pattern '<same pattern>'`. Reading the hits: grep 3 with more than one hit per section breaks rule 2, and any hit on grep 5 breaks rule 23 unless the matched noun names a person or device that can act. On grep 6, existential "there is/are" is a false positive and a demonstrative already followed by a noun is clean; every other survivor owes you a three-word antecedent.

Three standing false positives:

* **Grep 7 (rule 25) and its false-positive twin.** "*the convergence of*", "*the implementation of*" name a hidden actor. Never audit rule 25 with an `is/are` + participle grep: in technical prose *is bounded*, *is stable*, *is Hurwitz*, *is positive definite* are predicate adjectives, not hidden actors. One such grep reported 32 violations in a chapter where 24 were "is bounded".
* **Grep 2 and grep 4 keep the necessary hits.** "additionally" inside a definition ("asymptotic stability additionally requires convergence") states an extra condition; "not only" ("holds from every initial state, not only from nearby ones") excludes a real alternative. Both stay.
* **Math nouns are not zombie nouns.** "the solution of the Lyapunov equation", "a function of $x$", "the derivative of the bound" are the subject, not a verb in disguise.

**Machine signs.** Wikipedia's *Signs of AI writing* and the excess-vocabulary study catalog the habits of machine text. The rules above already cut most of them; a sign listed here is cut where it appears, unless it carries the meaning. Grep every visible sign before sending: cut or rewrite each hit on the spot, never argue with it. The catalog:

* Significance puffery: "stands/serves as a", "is a testament to", "plays a crucial role", "underscores its importance", "reflects broader trends", "marks a turning point", "indelible mark", "evolving landscape". Rule 3 cuts the words; the inflated sentences go with them.
* Copula avoidance: "serves as", "stands as", "represents", "constitutes" where "is" works; the avoidance is the sign.
* Vague attribution: "experts argue", "observers cite", "industry reports", "studies show" with no expert, report or study named. Name it or drop the claim (the same law as rule 19).
* Challenges-and-prospects closers: "Despite its success, X faces challenges…", "Future Outlook" sections. This is rule 21's padding at section scale.
* AI-vocabulary clusters: rule 3 words co-occur, one predicts the others; density is the sign, a lone word is not (source 6).
* Superficial "-ing" tails: "highlighting", "ensuring", "fostering", "cultivating", "encompassing" (rule 20).
* Negative parallelisms: "not only X but Y", "it is not just X, it's Y", "X rather than Y" where the contrast is decoration (rule 2; rule 15 when the halves are different types).
* Adjective or phrase triples where two items serve (rule 21).
* Dash rhythm: short phrase, dash, emphatic ending, the habit repeated. Presence is the sign, not density; rule 7 bans the em dash.
* Formatting signs: bold-for-emphasis everywhere, bold-label bullets, Title Case headings, scattered headings, emoji (rule 30).
* Chat residue and procedural self-narration: "Certainly!", "I hope this helps", "let me know", "I preserved your wording", "while details are scarce" (rule 32).

**A lone sign proves nothing.** Wikipedia's own false-positive list: perfect grammar, formal or mixed register, blandness, one lone dash, one lone "delve". Signs count in clusters, and the studies collected there put human detection of machine text near chance. Reading stays the audit (rule 28), not sign-policing. Human prose drifts toward machine prose, not the reverse: the drift you defend against is your own.

## 6 Long texts

Length decides structure. The table gives screen thresholds; print doubles them because studied text is read more slowly than scanned text. Say which scale you applied.

| Unit length | Opening | Closing |
|---|---|---|
| ≤ 500 words (screen) / ≤ 1000 (print) | nothing; headings carry it | nothing |
| above that, up to a chapter | preview: 2–4 sentences | nothing |
| a chapter or long section (≤ 3000 words screen / 6000 print) | preview: 3–5 sentences | consolidation block (rule 35) |
| whole document (> ~6000 words) | standalone front matter (rule 37) + preview per unit | consolidation per unit |

33. **Structure follows length, not taste.** Apply the table. Adding a recap to a short note is a violation, not caution.
34. **A long unit opens with a preview, never an announcer.** The preview delivers the conclusion, the order of the argument and the reason for it, and the decision the reader can make afterwards. Keep the preview under ~120 words on screen, twice that in print. If the conclusion will not fit in the first sentence, the unit has no point yet: find it before writing prose.
35. **A long unit closes by consolidating, not paraphrasing.** At most five items, each one of: a retrieval prompt the reader answers from memory; a consequence statement (what the result forbids, what fails if the assumption is dropped); a decision rule for practice. Never a prose restatement of the unit's own sentences.
36. **Pass the skim test.** Title, headings, the first paragraph of each unit and the last consolidation must leave the reader with a correct but incomplete model, never a wrong one. If the skim path misleads, fix the structure: move the conclusion up, rename the heading, or rewrite the preview.
37. **Front matter for decision-makers stands alone.** State the conclusion, the request, the cost and the risk. Order by importance, not by discovery, so every paragraph survives being the last one read. Where a field's house style is method-first (IMRaD papers, lemma-first proofs), follow that style and put the conclusion in the abstract.

## 7 Overlays

A domain needs more than this file (typeset mathematics, legal, marketing). That law lives in the project holding the problem: for the adaptive-control lecture notes, `writing-rules.md` beside `main.tex`. When a second project needs the same rules, promote them upstream by hand.

## 8 Worked examples

Failing text and its fix, one line per case, with the rule behind each fix named.

1. "The bound holds only in the linear regime. In other words, outside it the bound says nothing." Rule 1: the second sentence restates the first; keep the half that carries the constraint.
2. "We omit the argument from signals, but not their time dependence." Rule 22: the main point died in a subordinate clause; write "We omit the argument from time-dependent signals."
3. A warning for the third time. Rules 8 and 9: the repeat must carry a new consequence, a decision, or a marker naming where it was established.
4. "Before adjusting a controller online we ask what we would do with known parameters." Rule 15: a parameter compares only with a parameter; fix the type, not the wording.
5. The skim path leaves a manager with the wrong conclusion. Rule 36: the structure is broken, not the prose; fix the order, not the adjectives.
6. "Robust control asks whether the closed loop is stable. There the unknown parameters still matter." Rule 23: a discipline cannot ask; the engineer asks, the field is the location. Rule 24: "There" named no container, so name one: "Inside that uncertainty set, the plant parameters still matter, provided the bound holds."
7. "The rate of convergence is fixed by the pole of the reference model, and the estimate carries the movement of the model itself." Rule 25: actors as subjects, actions as verbs: "The reference-model pole fixes the rate of convergence, and the estimate also includes how the model itself moves."
8. "The scope, the risks, the costs, and the timeline all live in this document." Rule 26: four nouns in front of the verb; write "This document states the scope. §2 covers risks, §3 costs, §4 timeline."
9. "Except as noted in §3, the upgrade runs automatically when the package is signed and the disk has room." Rule 22: main point first, conditions split: "The upgrade runs automatically. It needs a signed package and free disk; §3 lists exceptions."
10. A fifteen-line reply whose answer is one sentence. Rule 29: open with the answer and stop when the reader could act; the other fourteen lines were padding.
11. A README note ending "**Key takeaways:**" plus three bolded bullets. Rule 30: mechanical bold and a takeaways box fake structure. Rule 33: a ≤500-word unit closes with nothing; state the one conclusion in prose or delete it.

## 9 Sources

1. Gopen & Swan, *The Science of Scientific Writing*, American Scientist 78(6), 1990: topic and stress positions (rule 16).
2. Weinberger, Evans & Allesina, *Ten Simple (Empirical) Rules for Writing Science*, PLoS Comp. Biol. 11(4), 2015: short sentences out-cite long ones (rule 17).
3. Knuth, Cherry & Guibas, *Mathematical Writing*, 1989: no "clearly/obviously/trivially"; text must carry the argument (rule 19).
4. Halmos, *How to Write Mathematics*: notation economy (rule 14).
5. Dunloski et al., *Improving Students' Learning With Effective Learning Techniques*, PSPI 14(1), 2013: rereading low utility, retrieval and spacing high (rules 10, 35).
6. Kobak et al., *Delving into ChatGPT usage in academic writing through excess vocabulary*, 2024: LLM excess vocabulary: *delve* ~25× above trend by 2024, *showcase* and *underscore* ~9×; ≥10% of 2024 PubMed abstracts carried LLM signs (rule 3).
7. Wikipedia, *Signs of AI writing* (project page, retrieved 2026-10): the machine-sign catalog: significance puffery (AILEGACY), AI-vocabulary clusters (AIVOCAB), vague attribution (AIWEASEL), challenges-and-prospects closers (FACESCHALLENGES), superficial "-ing" analyses, rule-of-three (RO3), negative parallelisms, bold overuse (AIBOLD), Title Case headings, chat residue (COLLABCOMM), hedging disclaimers (AIDISCLAIMER), em-dash rhythm (AIDASH); plus the ineffective-indicators list and near-chance human detection studies (rules 20, 21, 30, 32).
8. Ausubel, *Educational Psychology: A Cognitive View*, 1968: the advance organizer (rule 34).
9. Bransford & Johnson, *Contextual prerequisites for understanding*, JVLVB 11(6), 1972: organizing context before reading raises comprehension of the same text (rule 34).
10. Mayer, *Multimedia Learning*, 2nd ed., 2009: signaling aids selection and organization; redundancy costs learning (rules 34, 35).
11. Marzano, Pickering & Pollock, *Classroom Instruction That Works*, 2001: summarization near d≈0.8 when the learner produces it; read against source 5, this settles rule 35 by making the reader produce something.
12. Weinreich et al., *Not Quite the Average*, ACM TOWeb 2(1), 2008, and the Nielsen Norman analyses built on it: reading time grows ~4.4 s per extra 100 words, so conclusions belong at the front (rules 36, 37).
13. Williams, Bizup & Trimble, *Style: Lessons in Clarity and Grace*, 12th ed., 2019: characters as subjects, actions as main verbs, zombie nouns, twenty-sentence self-check at ~70% (rule 25).
14. Zeiger, *Write Right! Communication Skills for Practicing Engineers*, 2nd ed., 2000: engineering prose has no licence for ambiguity: repeat the noun (rule 24a).
15. Sainani, *Writing in the Sciences*, Stanford University, since 2012: agent as subject, verbs instead of nominalisations (rule 25).
16. Google, *Developer Documentation Style Guide*, section *Pronouns*; U.S. *Federal Plain Language Guidelines*; KTH writing guide, *Use of pronouns with a clear reference*: a demonstrative takes a noun ("set this value", never "set this"); name the actor; the sentence-relative "which" as the cure for "This is…" (rules 23, 24).
17. U.S. *Federal Plain Language Guidelines* (plainlanguage.gov, GSA), from Garner, *Legal Writing in Plain English* 2001 and the Federal Register *Document Drafting Handbook*: keep the subject, verb, and object close together; write a topic sentence for every paragraph; place the main idea before exceptions and conditions (rules 26, 27 and 22).

