const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');

const app = express();
app.use(bodyParser.json());
app.use(express.static('.'));

let appointments = [];
let conversations = {};

try {
    if (fs.existsSync('appointments.json')) {
        appointments = JSON.parse(fs.readFileSync('appointments.json', 'utf8'));
    }
} catch (error) {
    console.log('No hay citas previas guardadas');
}

function saveAppointments() {
    fs.writeFileSync('appointments.json', JSON.stringify(appointments, null, 2));
}

// WEBHOOK VERIFICATION (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    console.log('Verificación webhook recibida:', { mode, token });
    
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
        console.log('✅ Webhook verificado correctamente');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Verificación fallida');
        res.sendStatus(403);
    }
});

// WEBHOOK MESSAGES (POST)
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    
    try {
        const body = req.body;
        
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const messages = value?.messages;
            
            if (messages && messages.length > 0) {
                const message = messages[0];
                const from = message.from;
                const text = message.text?.body || '';
                
                console.log(`📱 Mensaje recibido de ${from}: ${text}`);
                
                await processMessage(from, text);
            }
        }
    } catch (error) {
        console.error('❌ Error procesando webhook:', error);
    }
});

async function sendWhatsAppMessage(to, message) {
    try {
        const url = `https://graph.facebook.com/v18.0/${config.whatsapp.phoneNumberId}/messages`;
        
        await axios.post(url, {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: message }
        }, {
            headers: {
                'Authorization': `Bearer ${config.whatsapp.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`✅ Mensaje enviado a ${to}`);
    } catch (error) {
        console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
    }
}

function isOpenNow() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    if (!config.salon.workingDays.includes(day)) {
        return false;
    }
    
    const openHour = parseInt(config.salon.openTime.split(':')[0]);
    const closeHour = parseInt(config.salon.closeTime.split(':')[0]);
    
    return hour >= openHour && hour < closeHour;
}

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Buenos días';
    if (hour < 20) return 'Buenas tardes';
    return 'Buenas noches';
}

// Verificar si fecha/hora está en el pasado
function isInPast(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('/');
    const [hour, minute] = timeStr.split(':');
    const appointmentDate = new Date(year, month - 1, day, hour, minute);
    return appointmentDate < new Date();
}

// Verificar si está dentro del horario laboral
function isWithinWorkingHours(timeStr) {
    const [hour] = timeStr.split(':').map(Number);
    const openHour = parseInt(config.salon.openTime.split(':')[0]);
    const closeHour = parseInt(config.salon.closeTime.split(':')[0]);
    
    return hour >= openHour && hour < closeHour;
}

// Verificar si es día laboral
function isWorkingDay(dateStr) {
    const [day, month, year] = dateStr.split('/');
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay();
    
    return config.salon.workingDays.includes(dayOfWeek);
}

// Verificar disponibilidad de horario
function checkAvailability(staffName, date, time) {
    const conflict = appointments.find(apt => {
        // Si el staff es "Indiferente", no verificar por peluquero
        if (staffName === 'Indiferente') {
            return apt.dateFormatted === date && apt.time === time;
        }
        
        return apt.staff.name === staffName && 
               apt.dateFormatted === date && 
               apt.time === time;
    });
    
    return !conflict;
}

// Sugerir horarios alternativos
function getSuggestedTimes(staffName, date) {
    const busyTimes = appointments
        .filter(apt => {
            if (staffName === 'Indiferente') {
                return apt.dateFormatted === date;
            }
            return apt.staff.name === staffName && apt.dateFormatted === date;
        })
        .map(apt => apt.time);
    
    const openHour = parseInt(config.salon.openTime.split(':')[0]);
    const closeHour = parseInt(config.salon.closeTime.split(':')[0]);
    
    const allTimes = [];
    for (let h = openHour; h < closeHour; h++) {
        allTimes.push(`${h.toString().padStart(2, '0')}:00`);
        allTimes.push(`${h.toString().padStart(2, '0')}:30`);
    }
    
    const availableTimes = allTimes.filter(time => !busyTimes.includes(time));
    
    return availableTimes.slice(0, 3);
}

async function processMessage(from, text) {
    const lowerText = text.toLowerCase().trim();
    
    if (!conversations[from]) {
        conversations[from] = {
            step: 'initial',
            data: {}
        };
    }
    
    const conv = conversations[from];
    const isOpen = isOpenNow();
    
    // PASO 0: Saludo inicial
    if (conv.step === 'initial') {
        const greeting = getGreeting();
        const salonStatus = isOpen ? '' : '\n\nAunque el salón está cerrado ahora, estoy aquí para ayudarte las 24 horas.';
        
        await sendWhatsAppMessage(from, 
            `${greeting} Soy Ana, tu asistente virtual de ${config.salon.name}${salonStatus}\n\n¿Deseas reservar una cita?\n\nResponde:\n• SI\n• NO`
        );
        
        conv.step = 'confirm_booking';
        return;
    }
    
    // PASO 1: Confirmar si quiere reservar
    if (conv.step === 'confirm_booking') {
        if (lowerText.includes('si') || lowerText.includes('sí')) {
            let servicesText = 'Perfecto ¿Qué servicio te gustaría?\n\n';
            config.services.forEach((service, index) => {
                servicesText += `${index + 1}. ${service.name} - ${service.price}€ (${service.duration}min)\n`;
            });
            servicesText += '\nEscribe el número del servicio que deseas.';
            
            await sendWhatsAppMessage(from, servicesText);
            conv.step = 'select_service';
        } else {
            await sendWhatsAppMessage(from, 
                'Entendido. Si cambias de opinión, escríbeme cuando quieras. Estoy aquí para ayudarte.'
            );
            delete conversations[from];
        }
        return;
    }
    
    // PASO 2: Seleccionar servicio
    if (conv.step === 'select_service') {
        const serviceIndex = parseInt(lowerText) - 1;
        
        if (serviceIndex >= 0 && serviceIndex < config.services.length) {
            conv.data.service = config.services[serviceIndex];
            
            let staffText = 'Genial ¿Con qué peluquero prefieres?\n\n';
            config.staff.forEach((person, index) => {
                staffText += `${index + 1}. ${person.name} - ${person.specialty}\n`;
            });
            staffText += `${config.staff.length + 1}. Indiferente\n\nEscribe el número.`;
            
            await sendWhatsAppMessage(from, staffText);
            conv.step = 'select_staff';
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor, escribe un número válido de la lista de servicios.'
            );
        }
        return;
    }
    
    // PASO 3: Seleccionar peluquero
    if (conv.step === 'select_staff') {
        const staffIndex = parseInt(lowerText) - 1;
        
        if (staffIndex >= 0 && staffIndex <= config.staff.length) {
            if (staffIndex === config.staff.length) {
                conv.data.staff = { name: 'Indiferente' };
            } else {
                conv.data.staff = config.staff[staffIndex];
            }
            
            await sendWhatsAppMessage(from, 
                'Perfecto ¿Para cuándo deseas la cita?\n\nEscribe la fecha y hora así:\n📅 DD/MM/YYYY HH:MM\n\nEjemplo: 15/10/2024 14:30'
            );
            conv.step = 'select_datetime';
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor, escribe un número válido de la lista.'
            );
        }
        return;
    }
    
    // PASO 4: Seleccionar fecha y hora CON VALIDACIONES
    if (conv.step === 'select_datetime') {
        const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
        
        if (dateMatch) {
            const [, day, month, year, hour, minute] = dateMatch;
            const dateFormatted = `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
            const timeFormatted = `${hour.padStart(2, '0')}:${minute}`;
            
            // VALIDACIÓN 1: Verificar si está en el pasado
            if (isInPast(dateFormatted, timeFormatted)) {
                await sendWhatsAppMessage(from, 
                    '❌ No puedo reservar citas en el pasado.\n\nPor favor, escribe una fecha futura:\n📅 DD/MM/YYYY HH:MM'
                );
                return;
            }
            
            // VALIDACIÓN 2: Verificar si es día laboral
            if (!isWorkingDay(dateFormatted)) {
                await sendWhatsAppMessage(from, 
                    `❌ El salón no abre ese día.\n\nDías laborables: Lunes a Sábado\n\nPor favor, escribe otra fecha:\n📅 DD/MM/YYYY HH:MM`
                );
                return;
            }
            
            // VALIDACIÓN 3: Verificar si está dentro del horario laboral
            if (!isWithinWorkingHours(timeFormatted)) {
                await sendWhatsAppMessage(from, 
                    `❌ Esa hora está fuera de nuestro horario.\n\nHorario: ${config.salon.openTime} - ${config.salon.closeTime}\n\nPor favor, escribe otra hora:\n📅 DD/MM/YYYY HH:MM`
                );
                return;
            }
            
            // VALIDACIÓN 4: Verificar disponibilidad
            const staffName = conv.data.staff.name;
            const isAvailable = checkAvailability(staffName, dateFormatted, timeFormatted);
            
            if (!isAvailable) {
                const suggestedTimes = getSuggestedTimes(staffName, dateFormatted);
                
                if (suggestedTimes.length > 0) {
                    await sendWhatsAppMessage(from, 
                        `❌ Lo siento, ${staffName} ya tiene una cita el ${dateFormatted} a las ${timeFormatted}.\n\n✅ Horarios disponibles ese día:\n\n${suggestedTimes.map((t, i) => `${i+1}. ${t}`).join('\n')}\n\n¿Prefieres alguno de estos horarios?\n\nO escribe otra fecha completa: DD/MM/YYYY HH:MM`
                    );
                } else {
                    await sendWhatsAppMessage(from, 
                        `❌ Lo siento, ${staffName} no tiene disponibilidad el ${dateFormatted}.\n\nPor favor, escribe otra fecha:\n📅 DD/MM/YYYY HH:MM`
                    );
                }
                return;
            }
            
            // TODO VALIDADO - Guardar fecha y hora
            const appointmentDate = new Date(year, month - 1, day, hour, minute);
            conv.data.date = appointmentDate.toISOString();
            conv.data.dateFormatted = dateFormatted;
            conv.data.time = timeFormatted;
            
            // Mostrar confirmación
            const confirmText = `
✨ CONFIRMACIÓN DE CITA ✨

📅 Fecha: ${conv.data.dateFormatted}
🕐 Hora: ${conv.data.time}
✂️ Servicio: ${conv.data.service.name}
💇 Peluquero: ${conv.data.staff.name}
💰 Precio: ${conv.data.service.price}€

¿Confirmas esta cita?

Responde:
- CONFIRMA
- RECHAZA
            `.trim();
            
            await sendWhatsAppMessage(from, confirmText);
            conv.step = 'confirm_appointment';
        } else {
            await sendWhatsAppMessage(from, 
                '❌ Formato incorrecto.\n\nPor favor escribe así:\n📅 DD/MM/YYYY HH:MM\n\nEjemplo: 25/10/2024 16:00'
            );
        }
        return;
    }
    
    // PASO 5: Confirmar cita
    if (conv.step === 'confirm_appointment') {
        if (lowerText.includes('confirma')) {
            const appointment = {
                id: Date.now(),
                phone: from,
                ...conv.data,
                createdAt: new Date().toISOString()
            };
            
            appointments.push(appointment);
            saveAppointments();
            
            await sendWhatsAppMessage(from, 
                `🎉 ¡CITA CONFIRMADA! 🎉\n\n✅ Tu cita ha sido reservada exitosamente.\n\n📲 Recibirás un recordatorio 24h antes.\n\n⚠️ Para cancelar o modificar, comunícalo con 2h de anticipación.\n\n¡Gracias! Te esperamos en ${config.salon.name}`
            );
            
            delete conversations[from];
        } else if (lowerText.includes('rechaza')) {
            await sendWhatsAppMessage(from, 
                '❌ Cita cancelada. Si deseas reservar otra, escríbeme cuando quieras.'
            );
            delete conversations[from];
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor responde:\n• CONFIRMA\n• RECHAZA'
            );
        }
        return;
    }
    
    await sendWhatsAppMessage(from, 
        'Estoy aquí solo para ayudarte con reservas de citas.\n\n¿Deseas reservar una cita? Responde SI o NO.'
    );
    conv.step = 'confirm_booking';
}

app.get('/api/appointments', (req, res) => {
    res.json(appointments);
});

app.get('/api/status', (req, res) => {
    res.json({
        isOpen: isOpenNow(),
        appointments: appointments.length,
        conversations: Object.keys(conversations).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Bot WhatsApp funcionando en puerto ${PORT}`);
    console.log(`📱 Webhook: /webhook`);
    console.log(`🌐 Panel: http://localhost:${PORT}`);
});
