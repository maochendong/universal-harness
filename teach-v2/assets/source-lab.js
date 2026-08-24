(function () {
  "use strict";

  const prefix = "teach-v2:lab:";

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    return Promise.resolve();
  }

  function commandFor(button) {
    const normalize = (value) =>
      value
        .trim()
        .replace(/\\\s*\n\s*/g, " ")
        .replace(/\s+/g, " ");
    const targetId = button.dataset.commandTarget;
    if (targetId) {
      const target = document.getElementById(targetId);
      if (target) return normalize(target.textContent);
    }
    const lab = button.closest(".source-lab, .verification-lab, .lab-card");
    const command = lab && lab.querySelector("[data-command]");
    return command ? normalize(command.textContent) : "";
  }

  function updateLab(lab) {
    const id = lab.dataset.labId || lab.dataset.sourceLab;
    const status = lab.querySelector(".lab-status");
    if (!id || !status) return;
    const timestamp = localStorage.getItem(`${prefix}${id}`);
    if (timestamp) {
      status.dataset.state = "reported";
      status.textContent = `已自报运行：${new Date(timestamp).toLocaleString()}。这只是导航状态，不是掌握证明。`;
    } else {
      status.dataset.state = "not-run";
      status.textContent = "尚未自报运行。浏览器不能执行仓库命令，请复制到终端后核对结果。";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-copy-command]").forEach((button) => {
      button.addEventListener("click", async () => {
        const command = commandFor(button);
        if (!command) return;
        const original = button.textContent;
        try {
          await copyText(command);
          button.textContent = "已复制";
        } catch (_error) {
          button.textContent = "复制失败，请手动选择";
        }
        window.setTimeout(() => {
          button.textContent = original;
        }, 1800);
      });
    });

    document.querySelectorAll(".source-lab, .verification-lab, .lab-card").forEach((lab) => {
      updateLab(lab);
      const mark = lab.querySelector("[data-mark-lab]");
      if (!mark) return;
      mark.addEventListener("click", () => {
        const id = lab.dataset.labId || lab.dataset.sourceLab;
        if (!id) return;
        localStorage.setItem(`${prefix}${id}`, new Date().toISOString());
        updateLab(lab);
      });
    });

    document.querySelectorAll("[data-show-rubric]").forEach((button) => {
      button.addEventListener("click", () => {
        const exercise = button.closest(".decision-exercise, .decision-card");
        if (!exercise) return;
        const response = exercise.querySelector("textarea");
        const rubric = exercise.querySelector(".decision-rubric");
        if (!rubric) return;
        if (response && response.value.trim().length < 20) {
          response.focus();
          rubric.hidden = false;
          rubric.textContent =
            "先写下至少一句完整判断，再打开对照要点。检索前的提取练习才会留下更强记忆。";
          return;
        }
        const original = rubric.dataset.rubric || rubric.textContent;
        rubric.textContent = original;
        rubric.hidden = false;
      });
    });
  });
})();
