const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');
const exceljs = require('exceljs');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit'); 

const app = express();
const PORT = process.env.PORT || 3000;
const LIMITE_POR_GRUPO = 10;
const SENHA_ADMIN = process.env.SENHA_ADMIN || 'faama2026';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({ 
    secret: process.env.SESSION_SECRET || 'chave_reserva_segura_faama_2026', 
    resave: false, 
    saveUninitialized: true 
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Garante que o banco tenha a coluna de professor sem apagar os dados
pool.query(`ALTER TABLE eixos ADD COLUMN IF NOT EXISTS professor VARCHAR(255);`)
    .catch(err => console.error("Erro ao atualizar banco:", err));

// ================= TRAVA DE SEGURANÇA: FORÇA BRUTA =================
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: "Muitas tentativas de login incorretas. Sistema bloqueado por 15 minutos por segurança."
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
        const eixosRes = await pool.query('SELECT * FROM eixos');
        let eixos = eixosRes.rows;
        let relatorio = {};

        for (let eixo of eixos) {
            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1 ORDER BY nome', [eixo.id]);
            
            let tituloEixo = eixo.professor ? `${eixo.nome} (Prof. ${eixo.professor})` : eixo.nome;
            relatorio[tituloEixo] = { id: eixo.id, grupos: [] }; 
            
            let vagasTotais = gruposRes.rows.length * LIMITE_POR_GRUPO;
            let vagasOcupadas = 0;

            for (let grupo of gruposRes.rows) {
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [grupo.id]);
                
                let qtd = parseInt(totalCountRes.rows[0].qtd);
                vagasOcupadas += qtd;

                relatorio[tituloEixo].grupos.push({
                    nome_grupo: grupo.nome,
                    total: qtd,
                    alunos: alunosRes.rows
                });
            }
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

// ================= ROTA 3: INSCREVER E SORTEAR =================
app.post('/inscrever', async (req, res) => {
    const { nome, email, curso, turno, periodo, eixo_id } = req.body;

    try {
        // ================= TRAVA DE DUPLICIDADE MÁXIMA =================
        const checkDuplicata = await pool.query(
            'SELECT id FROM alunos WHERE email = $1 OR LOWER(TRIM(nome)) = LOWER(TRIM($2))', 
            [email, nome]
        );
        
        if (checkDuplicata.rows.length > 0) {
            req.session.erro = "❌ Ops! Já encontramos uma inscrição com este E-mail ou Nome Completo. Não é permitido trocar de grupo!";
            return res.redirect('/aluno');
        }
        // ==============================================================

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
            req.session.erro = "Este eixo já atingiu o limite de vagas! Por favor, escolha outro eixo.";
            return res.redirect('/aluno');
        }

        const minCurso = Math.min(...gruposDisponiveis.map(g => g.total_curso));
        const gruposCandidatos = gruposDisponiveis.filter(g => g.total_curso === minCurso);
        const grupoSorteado = gruposCandidatos[Math.floor(Math.random() * gruposCandidatos.length)];

        // O e-mail já estava sendo salvo aqui, então não precisou mudar nada no banco!
        await pool.query(
            'INSERT INTO alunos (nome, email, curso, turno, periodo, grupo_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [nome, email, curso, turno, periodo, grupoSorteado.id]
        );

        const colegasRes = await pool.query(
            'SELECT nome, curso, periodo FROM alunos WHERE grupo_id = $1 ORDER BY nome', 
            [grupoSorteado.id]
        );

        res.render('resultado', { nome, grupo: grupoSorteado.nome, colegas: colegasRes.rows });
    } catch (error) {
        console.error(error);
        req.session.erro = "Erro ao processar sua inscrição.";
        res.redirect('/aluno');
    }
});

// ================= ROTA 4: PAINEL ADMIN =================
app.get('/admin', checkAuth, async (req, res) => {
    try {
        const eixosRes = await pool.query('SELECT * FROM eixos ORDER BY nome');
        const eixos = eixosRes.rows;
        
        const listaGruposRes = await pool.query(`
            SELECT g.id, g.nome as grupo_nome, e.nome as eixo_nome 
            FROM grupos g JOIN eixos e ON g.eixo_id = e.id ORDER BY e.nome, g.nome
        `);
        const todosGrupos = listaGruposRes.rows;
        let relatorio = {};

        for (let eixo of eixos) {
            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1', [eixo.id]);
            const grupos = gruposRes.rows;
            
            let tituloEixo = eixo.professor ? `${eixo.nome} (Prof. ${eixo.professor})` : eixo.nome;
            relatorio[tituloEixo] = { id: eixo.id, grupos: [] }; 

            for (let grupo of grupos) {
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                const totalCountRes = await pool.query('SELECT COUNT(*) as qtd FROM alunos WHERE grupo_id = $1', [grupo.id]);

                relatorio[tituloEixo].grupos.push({
                    nome_grupo: grupo.nome,
                    total: totalCountRes.rows[0].qtd,
                    alunos: alunosRes.rows
                });
            }
        }
        res.render('admin', { relatorio, todosGrupos, eixos });
    } catch (error) {
        console.error("Erro ao carregar admin:", error);
        res.status(500).send("Erro ao carregar o painel administrativo.");
    }
});

// ================= ROTAS DE GERENCIAMENTO DE PROFESSORES =================
app.post('/admin/editar_professor', checkAuth, async (req, res) => {
    const { eixo_id, professor } = req.body;
    try {
        await pool.query('UPDATE eixos SET professor = $1 WHERE id = $2', [professor, eixo_id]);
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao atualizar professor:", error);
        res.redirect('/admin');
    }
});

app.post('/admin/remover_professor_eixo', checkAuth, async (req, res) => {
    const { eixo_id } = req.body;
    try {
        await pool.query('UPDATE eixos SET professor = NULL WHERE id = $1', [eixo_id]);
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao remover professor:", error);
        res.redirect('/admin');
    }
});

// ================= ROTAS DE GESTÃO (ALUNOS E EIXOS) =================
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

app.post('/admin/excluir_eixo', checkAuth, async (req, res) => {
    const { eixo_id } = req.body;
    try {
        await pool.query('DELETE FROM eixos WHERE id = $1', [eixo_id]);
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao excluir eixo:", error);
        res.redirect('/admin');
    }
});

app.post('/admin/criar_eixo', checkAuth, async (req, res) => {
    let { nome_eixo, descricao, professor, qtd_grupos } = req.body;
    professor = professor || null; 
    try {
        const result = await pool.query(
            'INSERT INTO eixos (nome, descricao, professor) VALUES ($1, $2, $3) RETURNING id', 
            [nome_eixo, descricao, professor]
        );
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

// ================= ROTA 6: LOGIN =================
app.post('/login', loginLimiter, (req, res) => {
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

// ================= ROTAS DE EXPORTAÇÃO =================
app.get('/admin/exportar/excel', checkAuth, async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Relatório de Equipes');

        worksheet.columns = [
            { header: 'Eixo', key: 'eixo', width: 35 }, 
            { header: 'Grupo', key: 'grupo', width: 25 },
            { header: 'Nome do Aluno', key: 'nome', width: 30 },
            { header: 'Email', key: 'email', width: 35 }, // Coluna do Email
            { header: 'Curso', key: 'curso', width: 25 },
            { header: 'Turno', key: 'turno', width: 15 },
            { header: 'Período', key: 'periodo', width: 10 }
        ];

        const query = `
            SELECT a.nome as aluno_nome, a.email, a.curso, a.turno, a.periodo,
                   g.nome as grupo_nome, e.nome as eixo_nome, e.professor as eixo_prof
            FROM alunos a JOIN grupos g ON a.grupo_id = g.id JOIN eixos e ON g.eixo_id = e.id
            ORDER BY e.nome, g.nome, a.nome
        `;
        const result = await pool.query(query);

        result.rows.forEach(row => {
            const nomeComProf = row.eixo_prof ? `${row.eixo_nome} (Prof. ${row.eixo_prof})` : row.eixo_nome;
            worksheet.addRow({
                eixo: nomeComProf, 
                grupo: row.grupo_nome, 
                nome: row.aluno_nome,
                email: row.email, 
                curso: row.curso, 
                turno: row.turno, 
                periodo: row.periodo + 'º'
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'relatorio_equipes_faama.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Erro ao exportar Excel:", error);
        res.status(500).send("Erro ao gerar o Excel.");
    }
});

app.get('/admin/exportar/pdf', checkAuth, async (req, res) => {
    try {
        // Reduzi um pouquinho as margens para caber o e-mail tranquilamente na folha A4
        const doc = new PDFDocument({ margin: 40 }); 
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=relatorio_equipes_faama.pdf');
        doc.pipe(res);

        doc.fontSize(20).fillColor('#004a9f').text('Relatório Oficial de Equipes - FAAMA', { align: 'center' });
        doc.moveDown();

        const eixosRes = await pool.query('SELECT * FROM eixos ORDER BY nome');

        for (let eixo of eixosRes.rows) {
            const nomeEixo = eixo.nome ? String(eixo.nome) : 'Eixo sem nome';
            const profEixo = eixo.professor ? `. Professor responsável: ${eixo.professor}` : ''; 
            
            doc.fontSize(16).fillColor('#000000').text(`EIXO: ${nomeEixo}${profEixo}`);
            doc.moveDown(0.5);

            const gruposRes = await pool.query('SELECT * FROM grupos WHERE eixo_id = $1 ORDER BY nome', [eixo.id]);

            for (let grupo of gruposRes.rows) {
                const nomeGrupo = grupo.nome ? String(grupo.nome) : 'Grupo sem nome';
                doc.fontSize(14).fillColor('#28a745').text(`  ${nomeGrupo}`);
                
                // Puxando todos os dados do aluno do banco de dados (o e-mail vem junto automaticamente com o "SELECT *")
                const alunosRes = await pool.query('SELECT * FROM alunos WHERE grupo_id = $1 ORDER BY nome', [grupo.id]);
                
                if (alunosRes.rows.length === 0) {
                    doc.fontSize(12).fillColor('#666666').text('    (Nenhum aluno inscrito ainda)');
                } else {
                    alunosRes.rows.forEach(aluno => {
                        const nomeAluno = aluno.nome ? String(aluno.nome) : 'Aluno sem nome';
                        const cursoAluno = aluno.curso ? String(aluno.curso) : 'Curso N/A';
                        const periodoAluno = aluno.periodo ? String(aluno.periodo) : '-';
                        const emailAluno = aluno.email ? String(aluno.email) : 'Sem E-mail'; // AQUI O E-MAIL!
                        
                        // Agora a linha do PDF mostra Nome, Curso, Período e o E-mail de contato!
                        doc.fontSize(12).fillColor('#333333').text(`    - ${nomeAluno} (${cursoAluno}, ${periodoAluno}º P) | E-mail: ${emailAluno}`);
                    });
                }
                doc.moveDown(0.5);
            }
            doc.moveDown();
        }
        doc.end();
    } catch (error) {
        console.error("Erro EXATO ao exportar PDF:", error);
        if (!res.headersSent) {
            res.status(500).send("Erro ao gerar o PDF.");
        }
    }
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));