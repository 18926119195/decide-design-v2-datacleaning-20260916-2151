import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const SPACY_URL = 'http://localhost:5001/extract_nouns';

const server = http.createServer((req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: 直接从 docuverse.json 抽取名词，返回 JSON
  if (req.url === '/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { filePath } = JSON.parse(body);
        
        // Read and parse docuverse file
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        
        if (data.kind !== 'docuverse-corpus' || !data.bookIndex?.stream) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '不是有效的 docuverse-corpus 文件' }));
          return;
        }
        
        const text = data.bookIndex.stream;
        
        // Call spaCy
        const spacyRes = await fetch(SPACY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            include_proper_nouns: true,
            include_nouns: true,
            min_length: 2
          })
        });
        
        const result = await spacyRes.json();
        
        // Count frequencies
        const nounFreq = {};
        result.nouns.forEach(n => {
          nounFreq[n.surface] = (nounFreq[n.surface] || 0) + 1;
        });
        
        const phraseFreq = {};
        result.noun_phrases.forEach(p => {
          phraseFreq[p.surface] = (phraseFreq[p.surface] || 0) + 1;
        });
        
        // Sort by frequency
        const sortedNouns = Object.entries(nounFreq)
          .sort((a, b) => b[1] - a[1])
          .map(([surface, count]) => ({ surface, count }));
        
        const sortedPhrases = Object.entries(phraseFreq)
          .sort((a, b) => b[1] - a[1])
          .map(([surface, count]) => ({ surface, count }));
        
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          sourceFile: path.basename(filePath),
          textLength: text.length,
          statistics: {
            totalNouns: result.nouns.length,
            totalPhrases: result.noun_phrases.length,
            uniqueNouns: sortedNouns.length,
            uniquePhrases: sortedPhrases.length
          },
          nouns: sortedNouns,
          phrases: sortedPhrases,
          rawData: result
        }, null, 2));
        
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 主页面
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spaCy 名词抽取测试</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0A0D12;
      color: #E5E7EB;
      padding: 2rem;
      line-height: 1.6;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      margin-bottom: 2rem;
      letter-spacing: -0.02em;
    }
    .upload-area {
      background: #0F131C;
      border: 2px dashed #38BDF8;
      border-radius: 16px;
      padding: 3rem;
      text-align: center;
      margin-bottom: 2rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .upload-area:hover { background: #161D2B; }
    .upload-area.dragover { border-color: #6EE7B7; background: #161D2B; }
    input[type="file"] { display: none; }
    .file-info {
      background: #161D2B;
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.9rem;
      color: #9CA3AF;
    }
    .file-info strong { color: #38BDF8; }
    textarea {
      width: 100%;
      min-height: 200px;
      background: #0F131C;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 1rem;
      color: #E5E7EB;
      font-family: inherit;
      font-size: 0.95rem;
      resize: vertical;
      margin-bottom: 1rem;
    }
    button {
      background: #38BDF8;
      color: #05070C;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover { background: #60D5FB; transform: translateY(-1px); }
    button:disabled { background: #374151; cursor: not-allowed; }
    .results {
      background: #0F131C;
      border-radius: 16px;
      padding: 2rem;
      margin-top: 2rem;
    }
    .section {
      margin-bottom: 2rem;
    }
    .section h3 {
      color: #38BDF8;
      margin-bottom: 1rem;
      font-size: 1.25rem;
    }
    .tag {
      display: inline-block;
      background: #1E2636;
      border: 1px solid #38BDF8;
      padding: 0.5rem 1rem;
      border-radius: 999px;
      margin: 0.25rem;
      font-size: 0.9rem;
    }
    .tag .pos {
      color: #6EE7B7;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: #161D2B;
      padding: 1.5rem;
      border-radius: 12px;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #38BDF8;
    }
    .stat-label {
      font-size: 0.875rem;
      color: #9CA3AF;
      margin-top: 0.25rem;
    }
    .loading {
      display: none;
      text-align: center;
      padding: 2rem;
      color: #38BDF8;
    }
    .loading.active { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>spaCy 名词抽取测试工具</h1>
    
    <div class="upload-area" id="uploadArea">
      <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">📄 点击或拖拽文件到此处</p>
      <p style="color: #9CA3AF; font-size: 0.9rem;">支持 .txt 或 .docuverse.json 文件</p>
      <input type="file" id="fileInput" accept=".txt,.json">
    </div>

    <div id="fileInfo" class="file-info" style="display: none;">
      <strong>已加载：</strong><span id="fileName"></span> 
      <span style="margin-left: 1rem;"><strong>类型：</strong><span id="fileType"></span></span>
      <span style="margin-left: 1rem;"><strong>文本长度：</strong><span id="textLength"></span> 字符</span>
    </div>

    <div>
      <textarea id="textInput" placeholder="或者直接在此输入文本..."></textarea>
      <button id="submitBtn" onclick="extractNouns()">抽取名词</button>
    </div>

    <div class="loading" id="loading">⏳ 处理中...</div>

    <div id="results" style="display: none;" class="results">
      <div class="stats">
        <div class="stat-card">
          <div class="stat-value" id="nounCount">0</div>
          <div class="stat-label">名词</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="phraseCount">0</div>
          <div class="stat-label">名词短语</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="totalCount">0</div>
          <div class="stat-label">总计</div>
        </div>
      </div>

      <div class="section">
        <h3>名词 (NOUN/PROPN)</h3>
        <div id="nounsContainer"></div>
      </div>

      <div class="section">
        <h3>名词短语 (Noun Phrases)</h3>
        <div id="phrasesContainer"></div>
      </div>

      <div class="section">
        <button id="exportBtn" onclick="exportReport()">📦 一键导出审查报告</button>
        <span style="margin-left: 1rem; color: #9CA3AF; font-size: 0.85rem;">
          导出 Markdown 文件，按出现频次排序，方便快速审查质量
        </span>
      </div>
    </div>
  </div>

  <script>
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const textInput = document.getElementById('textInput');
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');

    uploadArea.onclick = () => fileInput.click();

    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFile(file);
    });

    function handleFile(file) {
      const reader = new FileReader();
      const fileInfo = document.getElementById('fileInfo');
      const fileName = document.getElementById('fileName');
      const fileType = document.getElementById('fileType');
      const textLength = document.getElementById('textLength');

      reader.onload = (e) => {
        let text = '';
        let type = 'txt';
        
        // Check if it's a docuverse JSON file
        if (file.name.endsWith('.json') || file.name.includes('.docuverse.')) {
          try {
            const data = JSON.parse(e.target.result);
            if (data.kind === 'docuverse-corpus' && data.bookIndex?.stream) {
              // Extract text from docuverse stream
              text = data.bookIndex.stream;
              type = 'docuverse';
            } else {
              text = e.target.result;
              type = 'json';
            }
          } catch (err) {
            console.error('JSON parse error:', err);
            text = e.target.result;
            type = 'txt';
          }
        } else {
          text = e.target.result;
          type = 'txt';
        }

        textInput.value = text;
        fileName.textContent = file.name;
        fileType.textContent = type;
        textLength.textContent = text.length.toLocaleString();
        fileInfo.style.display = 'block';
      };
      
      reader.readAsText(file, 'UTF-8');
    }

    async function extractNouns() {
      const text = textInput.value.trim();
      if (!text) {
        alert('请输入文本');
        return;
      }

      loading.classList.add('active');
      results.style.display = 'none';

      try {
        const response = await fetch('http://localhost:5001/extract_nouns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            include_proper_nouns: true,
            include_nouns: true,
            min_length: 2
          })
        });

        const data = await response.json();
        displayResults(data);
      } catch (error) {
        alert('请求失败: ' + error.message);
      } finally {
        loading.classList.remove('active');
      }
    }

    let currentData = null; // Store for export

    function displayResults(data) {
      currentData = data; // Save for export

      document.getElementById('nounCount').textContent = data.nouns.length;
      document.getElementById('phraseCount').textContent = data.noun_phrases.length;
      document.getElementById('totalCount').textContent = data.total;

      const nounsContainer = document.getElementById('nounsContainer');
      nounsContainer.innerHTML = data.nouns.map(n => 
        \`<span class="tag">\${n.surface}<span class="pos">\${n.pos}</span></span>\`
      ).join('');

      const phrasesContainer = document.getElementById('phrasesContainer');
      phrasesContainer.innerHTML = data.noun_phrases.map(p => 
        \`<span class="tag">\${p.surface}<span class="pos">NP</span></span>\`
      ).join('');

      results.style.display = 'block';
    }

    function exportReport() {
      if (!currentData) {
        alert('没有可导出的数据');
        return;
      }

      // Count frequencies
      const nounFreq = {};
      currentData.nouns.forEach(n => {
        nounFreq[n.surface] = (nounFreq[n.surface] || 0) + 1;
      });

      const phraseFreq = {};
      currentData.noun_phrases.forEach(p => {
        phraseFreq[p.surface] = (phraseFreq[p.surface] || 0) + 1;
      });

      // Sort by frequency
      const sortedNouns = Object.entries(nounFreq)
        .sort((a, b) => b[1] - a[1]);
      
      const sortedPhrases = Object.entries(phraseFreq)
        .sort((a, b) => b[1] - a[1]);

      // Generate markdown
      const timestamp = new Date().toLocaleString('zh-CN');
      const fileName = document.getElementById('fileName')?.textContent || '未知';
      
      let md = \`# spaCy 名词抽取质量审查报告\\n\\n\`;
      md += \`**生成时间**: \${timestamp}\\n\\n\`;
      md += \`**源文件**: \${fileName}\\n\\n\`;
      md += \`---\\n\\n\`;
      md += \`## 统计摘要\\n\\n\`;
      md += \`- **名词总数**: \${currentData.nouns.length}\\n\`;
      md += \`- **名词短语总数**: \${currentData.noun_phrases.length}\\n\`;
      md += \`- **独立名词**: \${sortedNouns.length}\\n\`;
      md += \`- **独立短语**: \${sortedPhrases.length}\\n\\n\`;
      md += \`---\\n\\n\`;
      md += \`## 名词（按频次排序）\\n\\n\`;
      md += \`| 名词 | 出现次数 |\\n\`;
      md += \`|------|---------|\\n\`;
      sortedNouns.slice(0, 200).forEach(([noun, count]) => {
        md += \`| \${noun} | \${count} |\\n\`;
      });
      
      if (sortedNouns.length > 200) {
        md += \`\\n*（仅显示前 200 个，共 \${sortedNouns.length} 个）*\\n\`;
      }

      md += \`\\n---\\n\\n\`;
      md += \`## 名词短语（按频次排序）\\n\\n\`;
      md += \`| 短语 | 出现次数 |\\n\`;
      md += \`|------|---------|\\n\`;
      sortedPhrases.slice(0, 200).forEach(([phrase, count]) => {
        md += \`| \${phrase} | \${count} |\\n\`;
      });

      if (sortedPhrases.length > 200) {
        md += \`\\n*（仅显示前 200 个，共 \${sortedPhrases.length} 个）*\\n\`;
      }

      // Download
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`spacy-extraction-report-\${Date.now()}.md\`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  </script>
</body>
</html>
    `);
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n✅ 测试服务器已启动:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📝 spaCy sidecar: http://localhost:5001`);
  console.log(`\n打开浏览器访问测试页面\n`);
});
