const express = require('express');
const { Pool } = require('pg'); // Usando PostgreSQL
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

// Conexão com o banco do Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function checkAuth(req, res, next) {
    if (req.session.logado) {
        next();
    } else {
        req.session.erroLogin = "Acesso negado. Faça login primeiro.";
        res.redirect('/');
    }
}

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

// ================= ROTA 1: PORTAL INICIAL =================
app.get('/', (req, res) => {
    const erro = req.session.erroLogin;
    req.session.erroLogin = null;
    res.render('portal', { erro });
});

// ================= ROTA 2: TELA DO ALUNO (ATUALIZADA) =================
app.get('/aluno', async (req, res) => {
    try {
        const eixosRes = await pool.query('SELECT * FROM eixos');
        let eixos = eixosRes.rows;

        let relatorio = {};

        // Para cada eixo, vamos descobrir se ele está ESGOTADO
        for (let eixo of eixos) {
            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1 ORDER BY nome', [eixo.id]);
            relatorio[eixo.nome] = [];
            
            // Calculando vagas: Quantidade de grupos * 10 vagas
            let vagasTotais = gruposRes.rows.length * LIMITE_POR_GRUPO;
            let vagasOcupadas = 0;

            for (let grupo of gruposRes.rows) {
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [grupo.id]);
                
                let qtd = parseInt(totalCountRes.rows[0].qtd);
                vagasOcupadas += qtd;

                relatorio[eixo.nome].push({
                    nome_grupo: grupo.nome,
                    total: qtd,
                    alunos: alunosRes.rows
                });
            }
            
            // Se as vagas ocupadas forem maiores ou iguais as totais, ou se não tiver nenhum grupo criado, ele está LOTADO (true)
            eixo.lotado = (gruposRes.rows.length === 0) || (vagasOcupadas >= vagasTotais);
        }

        const erro = req.session.erro;
        req.session.erro = null; 
        
        res.render('index', { eixos, relatorio, erro }); 
    } catch (error) {
        console.error("Erro banco de dados:", error);
        res.status(500).send("Erro interno no servidor de banco de dados.");
    }
});

// ================= ROTA 3: INSCREVER E SORTEAR (ATUALIZADA) =================
app.post('/inscrever', async (req, res) => {
    // Pegando todos os dados do formulário, INCLUINDO O CELULAR
    const { nome, email, celular, curso, turno, periodo, eixo_id } = req.body;

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

        // Insere o aluno novo salvando também o CELULAR no banco de dados
        await pool.query(
            'INSERT INTO alunos (nome, email, celular, curso, turno, periodo, grupo_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [nome, email, celular, curso, turno, periodo, grupoSorteado.id]
        );

        // BUSCANDO OS COLEGAS: Trazendo nome, curso, CELULAR e PERÍODO para a tela final
        const colegasRes = await pool.query(
            'SELECT nome, curso, celular, periodo FROM alunos WHERE grupo_id = $1 ORDER BY nome', 
            [grupoSorteado.id]
        );

        res.render('resultado', { 
            nome, 
            grupo: grupoSorteado.nome, 
            colegas: colegasRes.rows 
        });

    } catch (error) {
        console.error(error);
        req.session.erro = "Erro ao processar sua inscrição.";
        res.redirect('/aluno');
    }
});


// ================= ROTA 4: PAINEL ADMIN (ATUALIZADA) =================
app.get('/admin', checkAuth, async (req, res) => {
    try {
        const eixosRes = await pool.query('SELECT * FROM eixos');
        const eixos = eixosRes.rows;
        
        // NOVA PARTE: Busca todos os grupos para o "Select" de realocação
        const listaGruposRes = await pool.query(`
            SELECT g.id, g.nome as grupo_nome, e.nome as eixo_nome 
            FROM grupos g 
            JOIN eixos e ON g.eixo_id = e.id 
            ORDER BY e.nome, g.nome
        `);
        const todosGrupos = listaGruposRes.rows;

        let relatorio = {};

        for (let eixo of eixos) {
            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1', [eixo.id]);
            const grupos = gruposRes.rows;
            
            relatorio[eixo.nome] = [];

            for (let grupo of grupos) {
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [grupo.id]);

                relatorio[eixo.nome].push({
                    nome_grupo: grupo.nome,
                    total: totalCountRes.rows[0].qtd,
                    alunos: alunosRes.rows
                });
            }
        }

        res.render('admin', { relatorio, todosGrupos });
        
    } catch (error) {
        console.error("Erro ao carregar admin:", error);
        res.status(500).send("Erro ao carregar o painel administrativo.");
    }
});


// ================= NOVAS ROTAS DE GESTÃO (EXCLUIR E MOVER) =================
app.post('/admin/excluir_aluno', checkAuth, async (req, res) => {
    const { aluno_id } = req.body;
    try {
        await pool.query('DELETE FROM alunos WHERE id = $1', [aluno_id]);
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao excluir aluno:", error);
        res.redirect('/admin');
    }
});

app.post('/admin/mover_aluno', checkAuth, async (req, res) => {
    const { aluno_id, novo_grupo_id } = req.body;
    try {
        // Verifica se o novo grupo não está cheio (opcional, mas recomendado)
        const countRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [novo_grupo_id]);
        if (parseInt(countRes.rows[0].qtd) < LIMITE_POR_GRUPO) {
            await pool.query('UPDATE alunos SET grupo_id = $1 WHERE id = $2', [novo_grupo_id, aluno_id]);
        }
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao mover aluno:", error);
        res.redirect('/admin');
    }
});

// ================= ROTA 5: CRIAR EIXO =================
app.post('/admin/criar_eixo', checkAuth, async (req, res) => {
    const { nome_eixo, descricao, qtd_grupos } = req.body;
    try {
        const result = await pool.query('INSERT INTO eixos (nome, descricao) VALUES ($1, $2) RETURNING id', [nome_eixo, descricao]);
        const eixoId = result.rows[0].id;

        for (let i = 1; i <= qtd_grupos; i++) {
            await pool.query('INSERT INTO grupos (nome, eixo_id) VALUES ($1, $2)', [`Equipe ${i} - ${nome_eixo}`, eixoId]);
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

// ================= ROTA EXPORTAR EXCEL =================
app.get('/admin/exportar/excel', checkAuth, async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Relatório de Equipes');

        // Criando o cabeçalho das colunas do Excel
        worksheet.columns = [
            { header: 'Eixo', key: 'eixo', width: 20 },
            { header: 'Grupo', key: 'grupo', width: 25 },
            { header: 'Nome do Aluno', key: 'nome', width: 30 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Curso', key: 'curso', width: 25 },
            { header: 'Turno', key: 'turno', width: 15 },
            { header: 'Período', key: 'periodo', width: 10 }
        ];

        // Consulta avançada juntando as 3 tabelas (Alunos, Grupos e Eixos)
        const query = `
            SELECT a.nome as aluno_nome, a.email, a.curso, a.turno, a.periodo,
                   g.nome as grupo_nome, e.nome as eixo_nome
            FROM alunos a
            JOIN grupos g ON a.grupo_id = g.id
            JOIN eixos e ON g.eixo_id = e.id
            ORDER BY e.nome, g.nome, a.nome
        `;
        const result = await pool.query(query);

        // Preenchendo as linhas do Excel
        result.rows.forEach(row => {
            worksheet.addRow({
                eixo: row.eixo_nome,
                grupo: row.grupo_nome,
                nome: row.aluno_nome,
                email: row.email,
                curso: row.curso,
                turno: row.turno,
                periodo: row.periodo + 'º'
            });
        });

        // Enviando o arquivo para download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'relatorio_equipes_faama.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Erro ao exportar Excel:", error);
        res.status(500).send("Erro ao gerar o Excel.");
    }
});

// ================= ROTA EXPORTAR PDF =================
app.get('/admin/exportar/pdf', checkAuth, async (req, res) => {
    try {
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=relatorio_equipes_faama.pdf');
        doc.pipe(res);

        // Título do PDF
        doc.fontSize(20).fillColor('#004a9f').text('Relatório Oficial de Equipes - FAAMA', { align: 'center' });
        doc.moveDown();

        const eixosRes = await pool.query('SELECT * FROM eixos ORDER BY nome');

        // Para cada eixo, listamos os grupos e alunos
        for (let eixo of eixosRes.rows) {
            const nomeEixo = eixo.nome ? String(eixo.nome) : 'Eixo sem nome';
            doc.fontSize(16).fillColor('#000000').text(`EIXO: ${nomeEixo}`);
            doc.moveDown(0.5);

            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1 ORDER BY nome', [eixo.id]);

            for (let grupo of gruposRes.rows) {
                const nomeGrupo = grupo.nome ? String(grupo.nome) : 'Grupo sem nome';
                doc.fontSize(14).fillColor('#28a745').text(`  ${nomeGrupo}`);
                
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                
                if (alunosRes.rows.length === 0) {
                    doc.fontSize(12).fillColor('#666666').text('    (Nenhum aluno inscrito ainda)');
                } else {
                    alunosRes.rows.forEach(aluno => {
                        // Travas de segurança para evitar que o PDFKit trave com valores nulos
                        const nomeAluno = aluno.nome ? String(aluno.nome) : 'Aluno sem nome';
                        const cursoAluno = aluno.curso ? String(aluno.curso) : 'Curso N/A';
                        const periodoAluno = aluno.periodo ? String(aluno.periodo) : '-';
                        
                        doc.fontSize(12).fillColor('#333333').text(`    - ${nomeAluno} (${cursoAluno}, ${periodoAluno}º P)`);
                    });
                }
                doc.moveDown(0.5);
            }
            doc.moveDown();
        }

        doc.end();
    } catch (error) {
        // Agora o erro real vai aparecer nos logs do Render
        console.error("Erro EXATO ao exportar PDF:", error);
        if (!res.headersSent) {
            res.status(500).send("Erro ao gerar o PDF. Verifique os logs no Render.");
        }
    }
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));