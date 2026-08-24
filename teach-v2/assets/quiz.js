(function () {
  "use strict";

  const storagePrefix = "teach-v2:";

  function byId(id) {
    return document.getElementById(id);
  }

  window.selectOption = function selectOption(button) {
    const question = button.closest(".quiz-question-block");
    if (!question) return;
    question.querySelectorAll(".quiz-option").forEach((option) => {
      option.classList.remove("selected", "correct", "incorrect");
      option.setAttribute("aria-pressed", "false");
    });
    button.classList.add("selected");
    button.setAttribute("aria-pressed", "true");
    const feedback = question.querySelector(".quiz-feedback");
    if (feedback) feedback.className = "quiz-feedback";
  };

  window.checkQuiz = function checkQuiz(containerId) {
    const container = byId(containerId);
    if (!container) return;
    let allAnswered = true;
    container.querySelectorAll(".quiz-question-block").forEach((question) => {
      const selected = question.querySelector(".quiz-option.selected");
      const feedback = question.querySelector(".quiz-feedback");
      if (!selected) {
        allAnswered = false;
        if (feedback) {
          feedback.textContent = "先选择一个判断，再查看反馈。";
          feedback.className = "quiz-feedback show error";
        }
        return;
      }
      const correct = selected.dataset.value === question.dataset.correct;
      selected.classList.add(correct ? "correct" : "incorrect");
      if (feedback) {
        feedback.textContent = correct
          ? question.dataset.explanationRight || "判断成立。关键是沿权威边界继续验证。"
          : question.dataset.explanationWrong ||
            "再检查一次：这个选项把哪一层证据当成了更高层事实？";
        feedback.className = `quiz-feedback show ${correct ? "success" : "error"}`;
      }
    });
    if (allAnswered) {
      localStorage.setItem(`${storagePrefix}quiz:${containerId}`, new Date().toISOString());
      container.dataset.attempted = "true";
    }
  };

  window.resetQuiz = function resetQuiz(containerId) {
    const container = byId(containerId);
    if (!container) return;
    container.querySelectorAll(".quiz-option").forEach((option) => {
      option.classList.remove("selected", "correct", "incorrect");
      option.setAttribute("aria-pressed", "false");
    });
    container.querySelectorAll(".quiz-feedback").forEach((feedback) => {
      feedback.textContent = "";
      feedback.className = "quiz-feedback";
    });
  };

  window.showArchDesc = function showArchDesc(component) {
    const diagram = component.closest(".arch-diagram, .architecture-stack");
    if (!diagram) return;
    diagram.querySelectorAll(".arch-component").forEach((item) => item.classList.remove("active"));
    component.classList.add("active");
    const description = diagram.querySelector(".arch-description");
    if (description) description.textContent = component.dataset.desc || "此组件尚未提供说明。";
  };

  function initializeReveals() {
    const elements = document.querySelectorAll(".animate-in");
    if (!("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    elements.forEach((element, index) => {
      element.style.transitionDelay = `${Math.min(index % 4, 3) * 55}ms`;
      observer.observe(element);
    });
  }

  function findFlowActor(container, key) {
    if (!key) return null;
    const candidates = [key, `flow-${key}`, `flow-actor-${key}`];
    for (const id of candidates) {
      const match = Array.from(container.querySelectorAll(".flow-actor")).find(
        (actor) => actor.id === id || actor.dataset.actor === key,
      );
      if (match) return match;
    }
    return null;
  }

  function animatePacket(container, from, to) {
    const packet = container.querySelector(".flow-packet");
    if (!packet || !from || !to) return;
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const startX = fromRect.left + fromRect.width / 2 - 7;
    const startY = fromRect.top + fromRect.height / 2 - 7;
    const endX = toRect.left + toRect.width / 2 - 7;
    const endY = toRect.top + toRect.height / 2 - 7;
    packet.style.transition = "none";
    packet.style.transform = `translate(${startX}px, ${startY}px)`;
    packet.style.opacity = "1";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        packet.style.transition = "transform 450ms var(--ease-out), opacity 120ms";
        packet.style.transform = `translate(${endX}px, ${endY}px)`;
        window.setTimeout(() => {
          packet.style.opacity = "0";
        }, 470);
      });
    });
  }

  function initializeFlows() {
    document.querySelectorAll(".flow-animation").forEach((container) => {
      let steps;
      try {
        steps = JSON.parse(container.dataset.steps || "[]");
      } catch (_error) {
        const label = container.querySelector(".flow-step-label");
        if (label) label.textContent = "调用链数据无法解析，请检查 data-steps JSON。";
        return;
      }
      let index = -1;
      const label = container.querySelector(".flow-step-label");
      const progress = container.querySelector(".flow-progress");
      const nextButton = container.querySelector(".flow-next-btn");
      const resetButton = container.querySelector(".flow-reset-btn");

      function render() {
        const step = steps[index];
        container.querySelectorAll(".flow-actor, .flow-step").forEach((actor) => {
          actor.classList.remove("active");
        });
        if (!step) {
          if (label) label.textContent = "点击“下一步”开始追踪。";
          if (progress) progress.textContent = `0 / ${steps.length}`;
          return;
        }
        const highlighted = findFlowActor(container, step.highlight);
        const from = findFlowActor(container, step.from);
        const to = findFlowActor(container, step.to);
        [highlighted, from, to].filter(Boolean).forEach((actor) => actor.classList.add("active"));
        if (label) {
          label.innerHTML = "";
          const title = document.createElement("strong");
          title.textContent = step.label || `步骤 ${index + 1}`;
          label.appendChild(title);
          if (step.detail) {
            const detail = document.createElement("span");
            detail.textContent = ` — ${step.detail}`;
            label.appendChild(detail);
          }
        }
        if ((step.packet || (step.from && step.to)) && from && to)
          animatePacket(container, from, to);
        if (progress) progress.textContent = `${index + 1} / ${steps.length}`;
      }

      if (nextButton) {
        nextButton.addEventListener("click", () => {
          index = index + 1 >= steps.length ? 0 : index + 1;
          render();
        });
      }
      if (resetButton) {
        resetButton.addEventListener("click", () => {
          index = -1;
          render();
        });
      }
      render();
    });
  }

  function initializeChats() {
    document.querySelectorAll(".chat-window").forEach((container) => {
      const messages = Array.from(container.querySelectorAll(".chat-message")).sort(
        (left, right) => Number(left.dataset.msg || 0) - Number(right.dataset.msg || 0),
      );
      const next = container.querySelector(".chat-next-btn");
      const all = container.querySelector(".chat-all-btn");
      const reset = container.querySelector(".chat-reset-btn");
      const typing = container.querySelector(".chat-typing");
      const progress = container.querySelector(".chat-progress");
      let visible = 0;
      let timer;

      function update() {
        messages.forEach((message, index) => {
          message.style.display = index < visible ? "flex" : "none";
        });
        if (progress) progress.textContent = `${visible} / ${messages.length}`;
        if (typing)
          typing.style.display = visible > 0 && visible < messages.length ? "flex" : "none";
      }

      function stop() {
        if (timer) window.clearInterval(timer);
        timer = undefined;
      }

      if (next) {
        next.addEventListener("click", () => {
          stop();
          visible = Math.min(messages.length, visible + 1);
          update();
        });
      }
      if (all) {
        all.addEventListener("click", () => {
          stop();
          timer = window.setInterval(() => {
            visible += 1;
            update();
            if (visible >= messages.length) stop();
          }, 650);
        });
      }
      if (reset) {
        reset.addEventListener("click", () => {
          stop();
          visible = 0;
          update();
        });
      }
      update();
    });
  }

  function positionTooltip(term, tooltip) {
    document.body.appendChild(tooltip);
    const rect = term.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8),
    );
    tooltip.style.width = `${width}px`;
    tooltip.style.left = `${left}px`;
    const height = tooltip.offsetHeight;
    tooltip.style.top = `${rect.top - height - 8 >= 0 ? rect.top - height - 8 : rect.bottom + 8}px`;
  }

  function initializeTerms() {
    let active;
    document.querySelectorAll(".term[data-definition]").forEach((term) => {
      const tooltip = document.createElement("span");
      tooltip.className = "term-tooltip";
      tooltip.textContent = term.dataset.definition;
      const open = () => {
        if (active && active !== tooltip) active.remove();
        positionTooltip(term, tooltip);
        requestAnimationFrame(() => tooltip.classList.add("visible"));
        term.classList.add("active");
        active = tooltip;
      };
      const close = () => {
        tooltip.classList.remove("visible");
        term.classList.remove("active");
        window.setTimeout(() => {
          if (!tooltip.classList.contains("visible")) tooltip.remove();
        }, 160);
        if (active === tooltip) active = undefined;
      };
      term.addEventListener("mouseenter", open);
      term.addEventListener("mouseleave", close);
      term.addEventListener("click", (event) => {
        event.stopPropagation();
        if (tooltip.classList.contains("visible")) close();
        else open();
      });
    });
    document.addEventListener("click", () => {
      if (active) {
        active.classList.remove("visible");
        active.remove();
        active = undefined;
      }
    });
  }

  function initializeProgress() {
    const bars = document.querySelectorAll(".page-progress, .progress-bar");
    if (bars.length === 0) return;
    const update = () => {
      const available = document.documentElement.scrollHeight - window.innerHeight;
      const value = available <= 0 ? 100 : Math.min(100, (window.scrollY / available) * 100);
      bars.forEach((bar) => {
        bar.style.width = `${value}%`;
        bar.setAttribute("aria-valuenow", String(Math.round(value)));
      });
    };
    window.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
    update();
  }

  function initializeLearningState() {
    const lessonId = document.body.dataset.lessonId;
    if (lessonId) {
      localStorage.setItem(`${storagePrefix}visited:${lessonId}`, new Date().toISOString());
      document.querySelectorAll("[data-mark-reviewed]").forEach((button) => {
        const update = () => {
          const reviewed = Boolean(localStorage.getItem(`${storagePrefix}reviewed:${lessonId}`));
          button.textContent = reviewed ? "已标记复习（非掌握证明）" : "标记本课已复习";
          button.dataset.state = reviewed ? "reviewed" : "new";
        };
        button.addEventListener("click", () => {
          localStorage.setItem(`${storagePrefix}reviewed:${lessonId}`, new Date().toISOString());
          update();
        });
        update();
      });
    }

    document.querySelectorAll("[data-lesson-state]").forEach((element) => {
      const id = element.dataset.lessonState;
      const reviewed = localStorage.getItem(`${storagePrefix}reviewed:${id}`);
      const visited = localStorage.getItem(`${storagePrefix}visited:${id}`);
      element.textContent = reviewed ? "已复习" : visited ? "已浏览" : "未浏览";
      element.classList.toggle("status-connected", Boolean(reviewed));
      element.classList.toggle("status-partial", !reviewed && Boolean(visited));
    });

    const lessonIds = Array.from(document.querySelectorAll("[data-lesson-state]")).map(
      (element) => element.dataset.lessonState,
    );
    if (lessonIds.length > 0) {
      const reviewedCount = lessonIds.filter((id) =>
        localStorage.getItem(`${storagePrefix}reviewed:${id}`),
      ).length;
      const visitedCount = lessonIds.filter((id) =>
        localStorage.getItem(`${storagePrefix}visited:${id}`),
      ).length;
      document.querySelectorAll("[data-reviewed-count]").forEach((element) => {
        element.textContent = `${reviewedCount} / ${lessonIds.length}`;
      });
      document.querySelectorAll("[data-visited-count]").forEach((element) => {
        element.textContent = `${visitedCount} / ${lessonIds.length}`;
      });
      const nextId =
        lessonIds.find((id) => !localStorage.getItem(`${storagePrefix}reviewed:${id}`)) ||
        lessonIds[0];
      const next = document.querySelector(`[data-next-for="${nextId}"]`);
      const targets = document.querySelectorAll("[data-next-recommendation]");
      if (next) {
        targets.forEach((target) => {
          target.textContent = next.dataset.nextTitle || next.textContent.trim();
          if (next.getAttribute("href")) target.setAttribute("href", next.getAttribute("href"));
        });
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initializeReveals();
    initializeFlows();
    initializeChats();
    initializeTerms();
    initializeProgress();
    initializeLearningState();
  });
})();
