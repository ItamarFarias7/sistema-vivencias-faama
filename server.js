const express = require('express');
const { Pool } = require('pg'); // Mudamos de mysql2 para pg
const path = require('path');
const session = require('express-session');
const exceljs = require('exceljs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const LIMITE_POR_GRUPO = 10;
const SENHA_ADMIN = process.env.SENHA_ADMIN || 'faama2026';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'chave_secreta_faama', resave: false, saveUninitialized: true }));

// === CONFIGURAÇÃO DO POOL POSTGRESQL (NÍVEL IMPRESSIONADOR) ===
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // O Render preenche isso sozinho se você configurar no painel
    ssl: {
        rejectUnauthorized: false // Necessário para conexões seguras na nuvem
    }
});

function checkAuth(req, res, next) {
    if (req.session.logado) {
        next();
    } else {
        req.session.erroLogin = "Acesso negado. Faça login primeiro.";
        res.redirect('/');
    }
}

// ================= ROTA 1: PORTAL INICIAL =================
app.get('/', (req, res) => {
    const erro = req.session.erroLogin;
    req.session.erroLogin = null;
    res.render('portal', { erro });
});

// ================= ROTA 2: TELA DO ALUNO =================
app.get('/aluno', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM eixos');
        const eixos = result.rows;
        
        const erro = req.session.erro;
        req.session.erro = null; 
        res.render('index', { eixos, erro });
    } catch (error) {
        console.error("Erro banco de dados:", error);
        res.status(500).send("Erro interno no servidor de banco de dados.");
    }
});

// ================= ROTA 3: INSCREVER E SORTEAR =================
app.post('/inscrever', async (req, res) => {
    const { nome, email, curso, turno, periodo, eixo_id } = req.body;

    try {
        const gruposRes = await pool.query('SELECT id, nome FROM grupos WHERE eixo_id = $1', [eixo_id]);
        const grupos = gruposRes.rows;
        
        if (grupos.length === 0) {
            req.session.erro = "Nenhum grupo cadastrado neste eixo ainda.";
            return res.redirect('/aluno');
        }

        let gruposDisponiveis = [];

        for (let g of grupos) {
            const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [g.id]);
            const totalAlunos = parseInt(totalCountRes.rows[0].qtd);

            if (totalAlunos < LIMITE_POR_GRUPO) {
                const cursoCountRes = await pool.query(
                    'SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1 AND curso = $2', 
                    [g.id, curso]
                );
                gruposDisponiveis.push({ id: g.id, nome: g.nome, total_curso: parseInt(cursoCountRes.rows[0].qtd) });
            }
        }

        if (gruposDisponiveis.length === 0) {
            req.session.erro = "Todas as equipes deste eixo atingiram o limite!";
            return res.redirect('/aluno');
        }

        const minCurso = Math.min(...gruposDisponiveis.map(g => g.total_curso));
        const gruposCandidatos = gruposDisponiveis.filter(g => g.total_curso === minCurso);
        const grupoSorteado = gruposCandidatos[Math.floor(Math.random() * gruposCandidatos.length)];

        await pool.query(
            'INSERT INTO alunos (nome, email, curso, turno, periodo, grupo_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [nome, email, curso, turno, periodo, grupoSorteado.id]
        );

        res.render('resultado', { nome, grupo: grupoSorteado.nome });

    } catch (error) {
        console.error(error);
        req.session.erro = "Erro ao processar sua inscrição.";
        res.redirect('/aluno');
    }
});

// ================= ROTA 4: PAINEL ADMIN =================
app.get('/admin', checkAuth, async (req, res) => {
    try {
        const eixosRes = await pool.query('SELECT * FROM eixos');
        const eixos = eixosRes.rows;
        
        let relatorio = {};

        for (let eixo of eixos) {
            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1', [eixo.id]);
            const grupos = gruposRes.rows;
            
            relatorio[eixo.nome] = [];

            for (let grupo of grupos) {
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1', [grupo.id]);
                const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [grupo.id]);

                relatorio[eixo.nome].push({
                    nome_grupo: grupo.nome,
                    total: totalCountRes.rows[0].qtd,
                    alunos: alunosRes.rows
                });
            }
        }

        res.render('admin', { relatorio });
        
    } catch (error) {
        console.error("Erro ao carregar admin:", error);
        res.status(500).send("Erro ao carregar o painel administrativo.");
    }
});

// ================= ROTA 5: CRIAR EIXO =================
app.post('/admin/criar_eixo', checkAuth, async (req, res) => {
    const { nome_eixo, descricao, qtd_grupos } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO eixos (nome, descricao) VALUES ($1, $2) RETURNING id', 
            [nome_eixo, descricao]
        );
        
        const eixoId = result.rows[0].id;

        for (let i = 1; i <= qtd_grupos; i++) {
            await pool.query(
                'INSERT INTO grupos (nome, eixo_id) VALUES ($1, $2)', 
                [`Equipe ${i} - ${nome_eixo}`, eixoId]
            );
        }

        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.redirect('/admin');
    }
});

// ================= ROTA 6: LOGIN POST =================
app.post('/login', (req, res) => {
    if (req.body.senha === SENHA_ADMIN) {
        req.session.logado = true;
        res.redirect('/admin');
    } else {
        req.session.erroLogin = "Senha incorreta.";
        res.redirect('/');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ================= ROTA SECRETA PARA CRIAR AS TABELAS =================
app.get('/setup-db', async (req, res) => {
    try {
        const query = `
            CREATE TABLE IF NOT EXISTS eixos (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                descricao TEXT
            );

            CREATE TABLE IF NOT EXISTS grupos (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                eixo_id INTEGER REFERENCES eixos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS alunos (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                curso VARCHAR(100),
                turno VARCHAR(50),
                periodo INTEGER,
                grupo_id INTEGER REFERENCES grupos(id) ON DELETE CASCADE
            );
        `;
        
        await pool.query(query);
        res.send("<h1>Tabelas criadas com sucesso, Impressionador! 🚀</h1><a href='/'>Voltar pro portal</a>");
    } catch (error) {
        console.error(error);
        res.status(500).send("Erro ao criar as tabelas: " + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});