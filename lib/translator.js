// Compiled Host ESM module for DeepSeek Harness (dsh 0.2.2+)
const MAX_DETAIL_LEN = 64;

function truncate(input, maxLen = MAX_DETAIL_LEN) {
  if (typeof input !== 'string') return undefined;
  const cleaned = input.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function basename(filePath) {
  if (typeof filePath !== 'string') return undefined;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return undefined;
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function pickArg(args, keys) {
  if (!args || typeof args !== 'object') return undefined;
  for (const key of keys) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

function pickVariant(items, seed) {
  const idx = Math.abs(Math.floor(seed)) % items.length;
  return items[idx];
}

function hashText(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function extractMeaningfulCmdLine(command) {
  if (typeof command !== 'string') return undefined;
  const lines = command
    .split(/\r?\n|&&|;/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l || l.startsWith('#')) return false;
      if (/^(@['"]|['"]@|[{}()\[\]]+|\$null\s*=|try\s*\{|catch\s*\{)$/i.test(l)) return false;
      if (/^(\$ErrorActionPreference|set\s+-[euo]|cd\s+|Set-Location\s+|chcp\s+|\[Console\]::|Import-Module\s+)/i.test(l)) return false;
      if (/^\$[a-z_][\w]*\s*=\s*(@['"]|Get-Date\b)/i.test(l)) return false;
      return true;
    });
  return lines[0] || command.replace(/\s+/g, ' ').trim();
}

function extractTargetFromCmd(text) {
  if (!text) return undefined;
  // Extract a meaningful filename or API path (e.g. package.json, *.mjs, /dsh-live-status-hud/debug)
  const apiMatch = text.match(/(\/[\w-]+\/[\w.-]+)/);
  const fileMatch = text.match(/(?:\*\.[a-z0-9]+|[\w.-]+\.(?:json|yaml|yml|tsx|jsx|mjs|cjs|html|css|ps1|sql|exe|zip|ts|js|md|py))/i);
  if (fileMatch) return fileMatch[0];
  if (apiMatch) return apiMatch[1];
  const dirMatch = text.match(/[A-Za-z]:\\[^\s'"]+|\.[\/][\w.-]+/);
  return dirMatch ? basename(dirMatch[0]) : undefined;
}

function describeShellCommandZh(command, description, isPlayful) {
  const descClean = truncate(description, 32);
  const hasZhDesc = Boolean(descClean && /[\u4e00-\u9fff]/.test(descClean));
  if (hasZhDesc) return descClean;

  const full = typeof command === 'string' ? command : '';
  const line = extractMeaningfulCmdLine(full) || '';
  const lower = `${line}\n${full}`.toLowerCase();
  const target = extractTargetFromCmd(line) || extractTargetFromCmd(full);

  if (/(node\s+--test|pnpm\s+test|npm\s+test|pytest|vitest|jest|mocha)/.test(lower)) {
    return target ? `运行自动化测试（${target}）` : '运行自动化测试';
  }
  if (/(dsh\s+plugin|pnpm\s+(add|install|i\b|remove)|npm\s+(install|i\b|uninstall))/.test(lower)) {
    return target ? `安装或更新插件（${target}）` : '安装或更新插件依赖';
  }
  if (/(pnpm\s+(run\s+)?build|npm\s+run\s+build|\btsc\b|esbuild|vite\s+build|webpack)/.test(lower)) {
    return target ? `编译构建（${target}）` : '编译构建项目产物';
  }
  if (/(expand-archive|compress-archive|\bunzip\b|\btar\b|\bzip\b|zipfile)/.test(lower)) {
    return target ? `打包或解压文件（${target}）` : '打包或解压压缩包';
  }
  if (/(copy-item|\bcp\b|\bxcopy\b|robocopy)/.test(lower)) {
    return target ? `复制文件（${target}）` : '复制或覆盖文件';
  }
  if (/(move-item|\bmv\b|rename-item)/.test(lower)) {
    return target ? `移动或重命名（${target}）` : '移动或重命名文件';
  }
  if (/(remove-item|\brm\b|\bdel\b)/.test(lower)) {
    return target ? `清理删除（${target}）` : '清理或删除文件';
  }
  if (/(select-string|\brg\b|\bgrep\b|findstr)/.test(lower)) {
    return target ? `在 ${target} 中搜索关键字` : '在代码中搜索关键字';
  }
  if (/(get-content|\bcat\b|\bhead\b|\btail\b|\btype\b|readfilesync)/.test(lower)) {
    return target ? `读取文件内容（${target}）` : '读取文件内容';
  }
  if (/(set-content|out-file|writefilesync|write_text)/.test(lower)) {
    return target ? `写入修改文件（${target}）` : '写入或修改文件';
  }
  if (/(get-childitem|\bls\b|\bdir\b)/.test(lower)) {
    return target ? `扫描目录文件（${target}）` : '列出目录文件列表';
  }
  if (/(\bgit\s+(status|diff|log|add|commit|push|pull|checkout|branch))/.test(lower)) {
    return '检查或提交 Git 变更';
  }
  if (/(invoke-webrequest|invoke-restmethod|\bcurl\b|\biwr\b|\bfetch\s*\(|http:\/\/127\.0\.0\.1)/.test(lower)) {
    return target ? `请求并测试本地接口（${target}）` : '请求并测试接口状态';
  }
  if (/(get-process|stop-process|get-nettcpconnection|taskkill|netstat)/.test(lower)) {
    return '检查或管理本地进程与端口';
  }
  if (/^(node|python|python3|py)\b/.test(line.toLowerCase())) {
    return target ? `运行脚本处理（${target}）` : '运行本地脚本处理任务';
  }
  if (descClean) return descClean;
  if (target) return `终端操作（${target}）`;
  return isPlayful ? '在终端里处理命令…' : '执行终端命令';
}

export function translateToolActivity(
  toolName,
  args,
  locale = 'zh-CN',
  persona = 'playful',
  seed = 0,
) {
  const lower = (toolName || 'tool').toLowerCase();
  const isZh = locale === 'zh-CN';
  const isPlayful = persona === 'playful';

  const filePath = pickArg(args, ['path', 'file_path', 'filePath', 'target', 'filename', 'file']);
  const fileName = basename(filePath);
  const command = pickArg(args, ['command', 'cmd', 'script', 'code', 'input']);
  const description = pickArg(args, ['description', 'summary', 'title', 'purpose']);
  const query = pickArg(args, ['query', 'pattern', 'search', 'keyword', 'q', 'url']);
  const mixSeed = seed + hashText(`${toolName}:${fileName ?? command ?? query ?? ''}`);

  if (/(^|[_:/-])(bash|pwsh|powershell|zsh|sh|shell|exec|terminal|command|run_command|cmd)($|[_:/-])/.test(lower)) {
    const cmdText = truncate(extractMeaningfulCmdLine(command) || command, 36);
    const fullDetail = truncate(command || description, 240);
    if (isZh) {
      return {
        label: describeShellCommandZh(command, description, isPlayful),
        detail: fullDetail,
      };
    }
    return {
      label: cmdText ? `Running ${cmdText}` : 'Running terminal command',
      detail: fullDetail,
    };
  }

  if (/(read|view|open|cat|inspect|get_file)/.test(lower)) {
    if (isZh && isPlayful) {
      const label = fileName
        ? pickVariant(
            [
              `翻开 ${fileName} 瞅两眼~`,
              `戴上眼镜精读 ${fileName} 中…`,
              `让我康康 ${fileName} 里写了啥！`,
            ],
            mixSeed,
          )
        : pickVariant(['正在翻阅文件内容~', '探头偷看代码里…'], mixSeed);
      return { label, detail: truncate(filePath) };
    }
    return {
      label: isZh
        ? fileName ? `正在读取 ${fileName}` : '正在读取文件内容'
        : fileName ? `Reading ${fileName}` : 'Reading file',
      detail: truncate(filePath),
    };
  }

  if (/(write|edit|patch|replace|create_file|save|apply_diff)/.test(lower)) {
    if (isZh && isPlayful) {
      const label = fileName
        ? pickVariant(
            [
              `拿起小画笔改写 ${fileName}~`,
              `给 ${fileName} 做个精致小手术！`,
              `噼里啪啦爆改 ${fileName} 中~`,
            ],
            mixSeed,
          )
        : pickVariant(['正在埋头敲代码改文件~', '挥舞小锤子修补代码中…'], mixSeed);
      return { label, detail: truncate(filePath) };
    }
    return {
      label: isZh
        ? fileName ? `正在修改 ${fileName}` : '正在编辑代码文件'
        : fileName ? `Editing ${fileName}` : 'Editing file',
      detail: truncate(filePath),
    };
  }

  if (/(grep|glob|find|ripgrep|list_dir|ls|search_files|code_search)/.test(lower)) {
    const qText = truncate(query, 28);
    if (isZh && isPlayful) {
      const label = qText
        ? pickVariant(
            [
              `拿放大镜满屋子找「${qText}」~`,
              `嗅嗅…正在代码堆里搜「${qText}」`,
              `翻箱倒柜定位「${qText}」中！`,
            ],
            mixSeed,
          )
        : pickVariant(['正在翻翻工作区里都有啥宝贝~', '拿着手电筒巡逻文件夹中…'], mixSeed);
      return { label, detail: truncate(query || filePath) };
    }
    return {
      label: isZh
        ? qText ? `正在检索「${qText}」` : '正在检索工作区文件'
        : qText ? `Searching "${qText}"` : 'Searching workspace',
      detail: truncate(query || filePath),
    };
  }

  if (/(web|search|browse|fetch|http|crawl|browser)/.test(lower)) {
    const qText = truncate(query, 30);
    if (isZh && isPlayful) {
      const label = qText
        ? pickVariant([`游去网上冲浪查查 ${qText}~`, `上网扒拉资料中：${qText}`], mixSeed)
        : '游去网上冲浪查资料啦~';
      return { label, detail: truncate(query) };
    }
    return {
      label: isZh
        ? qText ? `正在联网查询 ${qText}` : '正在联网检索资料'
        : qText ? `Searching web: ${qText}` : 'Browsing web',
      detail: truncate(query),
    };
  }

  if (/(subagent|delegate|agent|workflow|team|task)/.test(lower)) {
    const taskDesc = pickArg(args, ['role', 'title', 'description', 'prompt']);
    const shortDesc = truncate(taskDesc, 26);
    if (isZh && isPlayful) {
      return {
        label: shortDesc ? `摇人啦！派小伙伴去搞定：${shortDesc}` : '摇了个小伙伴一起干活~',
        detail: truncate(taskDesc),
      };
    }
    return {
      label: isZh
        ? shortDesc ? `正在调度子任务：${shortDesc}` : '正在协作执行子任务'
        : shortDesc ? `Delegating: ${shortDesc}` : 'Running subagent task',
      detail: truncate(taskDesc),
    };
  }

  if (lower.startsWith('mcp__') || lower.includes('mcp')) {
    const parts = toolName.split('__').filter(Boolean);
    const readable = parts.length >= 3 ? `${parts[1]} · ${parts.slice(2).join('_')}` : toolName;
    return {
      label: isZh
        ? isPlayful ? `掏出秘密道具 ${readable}~` : `正在调用外部工具 ${readable}`
        : `Calling MCP tool ${readable}`,
      detail: truncate(query || filePath || command),
    };
  }

  if (/(sql|query_db|doris|mysql|postgres|sqlite|database)/.test(lower)) {
    return {
      label: isZh
        ? isPlayful ? '潜进数据库里捞数据中~' : '正在执行数据库查询'
        : 'Running database query',
      detail: truncate(query || command),
    };
  }

  return {
    label: isZh
      ? isPlayful ? `掏出小工具 ${toolName} 忙活中~` : `正在调用工具 ${toolName}`
      : `Running ${toolName}`,
    detail: truncate(filePath || command || query),
  };
}

export function translatePhaseHeadline(phase, locale = 'zh-CN', persona = 'playful', seed = 0) {
  const isZh = locale === 'zh-CN';
  const isPlayful = persona === 'playful';

  if (isZh && persona === 'geek') {
    switch (phase) {
      case 'idle': return pickVariant(['[IDLE] 守护进程待命中', '[IDLE] 等待新指令输入'], seed);
      case 'thinking': return pickVariant(['[THINK] 上下文推理链路计算中…', '[THINK] 规划下一步执行图…'], seed);
      case 'running_tool': return pickVariant(['[EXEC] 工具管线运行中…', '[EXEC] 正在调度本地工具…'], seed);
      case 'waiting_approval': return '[GATE] 触发审批门禁，等待确认';
      case 'streaming': return '[STREAM] 正在流式输出响应…';
      case 'done': return '[OK] 本轮任务执行收敛 ✓';
      case 'error': return '[ERR] 执行链异常中断，请检查详情';
      default: return '[IDLE] 待命中';
    }
  }

  if (isZh && isPlayful) {
    switch (phase) {
      case 'idle':
        return pickVariant(['悠闲吐泡泡待命中~', '安安静静陪着你呢~'], seed);
      case 'thinking':
        return pickVariant(
          ['小脑瓜高速运转中，别催别催~', '托腮认真盘算下一步咋干！', '嗯哼，让我捋一捋最稳的思路~'],
          seed,
        );
      case 'running_tool':
        return pickVariant(['卷起袖子干活啦~', '工具咔咔运转中！'], seed);
      case 'waiting_approval':
        return pickVariant(['老大~ 这个操作要你点个头才敢冲！', '举手申请批准！点一下我就继续~'], seed);
      case 'streaming':
        return pickVariant(['灵感爆棚！正在疯狂码字回复~', '答案打包好啦，正火速发给你！'], seed);
      case 'done':
        return pickVariant(['大功告成！快来夸夸我~ ✨', '搞定收工！完美交卷啦~', '任务稳稳拿下，坐等下一单！'], seed);
      case 'error':
        return pickVariant(['哎呀绊了一小跤，快帮我瞅瞅报错！', '呜哇出点小状况，快来救场~'], seed);
    }
  }

  switch (phase) {
    case 'idle':
      return isZh ? '待命中' : 'Idle';
    case 'thinking':
      return isZh ? '正在思考下一步方案…' : 'Thinking through next step…';
    case 'running_tool':
      return isZh ? '正在执行工具操作…' : 'Executing tool…';
    case 'waiting_approval':
      return isZh ? '等待你的操作审批' : 'Waiting for your approval';
    case 'streaming':
      return isZh ? '正在组织并输出回复…' : 'Writing response…';
    case 'done':
      return isZh ? '本轮任务已完成' : 'Task completed';
    case 'error':
      return isZh ? '执行遇到异常，请查看详情' : 'Encountered an error';
    default:
      return isZh ? '待命中' : 'Idle';
  }
}

function isMostlyEnglish(text) {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return latin >= 4 && latin > cjk * 1.5;
}

function extractMentionedFile(sentence) {
  const match = sentence.match(/\b([\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|html|css|md|py|sql))\b/i);
  return match?.[1];
}

export function translateThoughtSentenceToCuteZh(sentence) {
  const clean = sentence.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (!isMostlyEnglish(clean)) return clean;

  const lower = clean.toLowerCase();
  const file = extractMentionedFile(clean);
  const seed = hashText(clean);

  if (/(ask_user|ask user|question|options|tell me|keep message short|reply|send a text)/.test(lower)) {
    return pickVariant(
      [
        '正在琢磨怎么用最简洁清楚的话问你或回复你~',
        '想给你准备几个好选的选项，让你点一下就行！',
        '整理好简短回复，准备马上发给你看~',
      ],
      seed,
    );
  }

  if (/(http|route|endpoint|rpc|poll|snapshot|fetch|api|server|client|returns real data)/.test(lower)) {
    return file
      ? `正在核对 ${file} 里的前后端接口数据，确认能正常拿到实时信息~`
      : pickVariant(
          [
            '正在核对前后端 HTTP 接口通道，确认实时数据已经通了~',
            '检查一下服务端返回的数据格式对不对得上~',
          ],
          seed,
        );
  }

  if (/(read the file|read |inspect|check |look at|examine|verify|see what)/.test(lower)) {
    return file
      ? `准备先翻开 ${file} 仔细检查一下细节，避免改错~`
      : pickVariant(
          ['准备先检查一下相关文件内容，摸清情况再动手~', '仔细核对一下上下文和细节，确保没遗漏！'],
          seed,
        );
  }

  if (/(edit|write|patch|fix|update|change|modify|add |remove |refactor|build)/.test(lower)) {
    return file
      ? `构思好了，准备动手修改 ${file} 里的代码逻辑~`
      : pickVariant(
          ['想好改动方案啦，准备动手写代码修补一下~', '正在盘算怎么改得最干净，不弄坏其他功能！'],
          seed,
        );
  }

  if (/(test|retry|error|fail|bug|debug|broken|issue|crash)/.test(lower)) {
    return pickVariant(
      [
        '遇到点小报错，正在分析原因并准备重试验证~',
        '打算跑一遍测试确认效果，稳妥第一！',
      ],
      seed,
    );
  }

  if (/(git|commit|branch|merge|push|pull|diff|pr|repo)/.test(lower)) {
    return pickVariant(
      ['正在检查 Git 版本变动，确认提交和代码差异干干净净~', '对照一下仓库变更记录，稳步推进！'],
      seed,
    );
  }

  if (/(pnpm|npm|install|package|build|bundle|compile|esbuild|tsc|webpack|vite)/.test(lower)) {
    return file
      ? `正在核对 ${file} 的构建与依赖配置，准备打包验证~`
      : pickVariant(
          ['正在检查依赖和构建产物，确保装上去一把就能跑通~', '核对打包配置中，不留半点隐患！'],
          seed,
        );
  }

  if (/(sql|database|table|schema|query|doris|mysql|postgres|index)/.test(lower)) {
    return pickVariant(
      ['正在梳理库表结构和查询条件，准备精准捞数据~', '核对 SQL 逻辑中，保证查得又快又准！'],
      seed,
    );
  }

  if (/(security|auth|token|origin|loopback|permission|redact|safe)/.test(lower)) {
    return pickVariant(
      ['正在检查安全权限和访问边界，守好安全护栏~', '给接口加上安全校验，放心稳妥！'],
      seed,
    );
  }

  if (/(bubble|render|overlay|layout|position|style|widget|ui|component)/.test(lower)) {
    return pickVariant(
      [
        '正在琢磨气泡和界面的显示效果，让它更顺眼~',
        '核对一下前端渲染逻辑，确保画面正常显示！',
      ],
      seed,
    );
  }

  if (/(avoid|no tool|instead|better|should|need to|let's|first|next|hmm|wait)/.test(lower)) {
    return pickVariant(
      [
        '嗯哼，权衡了一下还是走最省事稳妥的路线~',
        '正在规划下一步顺序，尽量少绕弯子！',
        '先跳过多余步骤，直接直奔主题搞定它~',
      ],
      seed,
    );
  }

  return file
    ? `正在围绕 ${file} 梳理处理思路~`
    : pickVariant(
        ['小脑袋瓜正在认真推演细节，马上就好~', '正在快速整理思路，准备进入下一步！'],
        seed,
      );
}

export function extractLatestThoughtSnippet(buffer, maxLen = 96) {
  const cleaned = buffer
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return undefined;
  if (cleaned.length <= maxLen) return cleaned;

  const sentences = cleaned
    .split(/(?<=[。！？.!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length > 0) {
    let tail = sentences[sentences.length - 1];
    if (tail.length < 28 && sentences.length >= 2) {
      tail = `${sentences[sentences.length - 2]} ${tail}`;
    }
    if (tail.length <= maxLen) return tail;
    return `…${tail.slice(tail.length - (maxLen - 1))}`;
  }

  return `…${cleaned.slice(cleaned.length - (maxLen - 1))}`;
}

export function translateThoughtBufferToCuteZh(buffer) {
  const cleaned = buffer
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/[#>*_`]/g, '')
    .trim();

  if (!cleaned) return { snippetZh: undefined, bufferZh: '' };

  if (!isMostlyEnglish(cleaned)) {
    return {
      snippetZh: extractLatestThoughtSnippet(cleaned, 86),
      bufferZh: cleaned,
    };
  }

  const rawSentences = cleaned
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);

  const translatedLines = [];
  for (const s of rawSentences.slice(-50)) {
    const zh = translateThoughtSentenceToCuteZh(s);
    if (zh && translatedLines[translatedLines.length - 1] !== zh) {
      translatedLines.push(zh);
    }
  }

  if (translatedLines.length === 0) {
    const fallback = translateThoughtSentenceToCuteZh(cleaned);
    return { snippetZh: fallback, bufferZh: fallback };
  }

  return {
    snippetZh: translatedLines[translatedLines.length - 1],
    bufferZh: translatedLines.map((line, i) => `${i + 1}. ${line}`).join('\n'),
  };
}
