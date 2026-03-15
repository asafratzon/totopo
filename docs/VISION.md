# VISION — totopo

## What is totopo?

totopo is an open source CLI that gives any developer a secure, isolated environment to work with AI coding assistants — in any project, from any directory, with a single command.

It is not an AI tool itself. It is the infrastructure that makes AI tools safe and pleasant to use locally.

---

## The Problem

AI coding assistants are powerful. Tools like Claude Code, Kilo, and OpenCode can read your codebase, write code, run commands, and make decisions autonomously. That power comes with a real risk: when you run an AI agent locally, it operates with your full user permissions. It can access files outside your project, push to remote repositories, read credentials, and interact with your system in ways you may not intend or even notice.

Most developers using AI CLIs today are one misconfigured prompt away from an agent that does something unintended with their codebase or system.

There is currently no simple, standardized way to run AI agents locally in a contained, auditable environment.

---

## The Goal

totopo makes secure, isolated AI-assisted development the default, not the exception — and does so without getting in the developer's way.

---

## Core Principles

**Security by default, not by configuration.**
The safe path is the easy path. totopo enforces isolation automatically, every time — without asking developers to configure anything.

**Developer experience is not an afterthought.**
Security and great DX are not in conflict. totopo is designed to be fast, clear, and pleasant to use. If the tool is a chore, developers will skip the isolation — so the experience must be worth it on its own terms.

**Transparency above all.**
Every decision totopo makes is documented, explained, and visible. The code is fully open source. There are no black boxes. A developer should be able to read exactly what totopo does and why.

**Zero noise in your repo.**
totopo lives in a single hidden directory at your repo root. It does not scatter files, does not modify your existing configuration, and can be removed completely in one command.

**Works with what you already have.**
totopo does not replace your editor, your git workflow, or your terminal. It adds a safe layer around AI tool usage without changing how you work.

**Open source, guaranteed, forever.**
totopo is MIT licensed and will remain fully open source unconditionally — not as a policy that could change, but as a founding commitment. This project is made and shared with love. Fork it, improve it, build something new from it. That is exactly what it is here for.

---

## Why Open Source?

A tool that sits between a developer and their AI agent — controlling what the agent can access and what it can do — must be fully auditable. Trust requires transparency.

totopo will always be open source. Not as a promise that could be walked back, but as the only version of this project that will ever exist. There is no private version. There is no enterprise tier. What you see is everything.

---

## Get Involved

totopo is in early development. The foundation works. The vision is clear. If you believe developers deserve better defaults for AI tool safety, contributions are welcome.

- Read the code
- Report issues
- Suggest improvements
- Fork it and build your own version — use totopo to do it safely
- Share it with developers who are running AI agents without isolation today
