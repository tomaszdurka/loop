'use client';

import { useState } from 'react';

export default function LeadForm() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    loanAmount: '',
    bankName: '',
    consent: false
  });

  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const validateForm = () => {
    const newErrors = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Imię i nazwisko jest wymagane';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!formData.email.trim()) {
      newErrors.email = 'Email jest wymagany';
    } else if (!emailRegex.test(formData.email)) {
      newErrors.email = 'Nieprawidłowy format email';
    }

    const phoneRegex = /^[+]?[\d\s-]{9,}$/;
    if (!formData.phone.trim()) {
      newErrors.phone = 'Telefon jest wymagany';
    } else if (!phoneRegex.test(formData.phone)) {
      newErrors.phone = 'Nieprawidłowy numer telefonu';
    }

    if (!formData.consent) {
      newErrors.consent = 'Zgoda jest wymagana';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    if (validateForm()) {
      // In production, send to API
      console.log('Form submitted:', formData);
      setSubmitted(true);

      // Reset form after 3 seconds
      setTimeout(() => {
        setFormData({
          name: '',
          email: '',
          phone: '',
          loanAmount: '',
          bankName: '',
          consent: false
        });
        setSubmitted(false);
      }, 3000);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));

    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  if (submitted) {
    return (
      <div className="bg-green-50 border-2 border-green-500 rounded-2xl p-10 text-center">
        <div className="text-6xl mb-4">✓</div>
        <h3 className="text-2xl font-bold text-green-900 mb-2">Dziękujemy!</h3>
        <p className="text-green-800">
          Twoja wiadomość została wysłana. Skontaktujemy się z Tobą w ciągu 24 godzin.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-xl p-8 md:p-10 border border-slate-200">
      <div className="text-center mb-8">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">
          Bezpłatna konsultacja
        </h2>
        <p className="text-slate-600">
          Wypełnij formularz, a nasz ekspert skontaktuje się z Tobą w ciągu 24h
        </p>
      </div>

      <div className="space-y-5">
        <div>
          <label htmlFor="name" className="block text-sm font-semibold text-slate-700 mb-2">
            Imię i nazwisko *
          </label>
          <input
            type="text"
            id="name"
            name="name"
            value={formData.name}
            onChange={handleChange}
            className={`w-full px-4 py-3 rounded-lg border ${
              errors.name ? 'border-red-500' : 'border-slate-300'
            } focus:outline-none focus:ring-2 focus:ring-blue-500`}
            placeholder="Jan Kowalski"
          />
          {errors.name && <p className="mt-1 text-sm text-red-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-semibold text-slate-700 mb-2">
            Email *
          </label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            className={`w-full px-4 py-3 rounded-lg border ${
              errors.email ? 'border-red-500' : 'border-slate-300'
            } focus:outline-none focus:ring-2 focus:ring-blue-500`}
            placeholder="jan.kowalski@example.com"
          />
          {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email}</p>}
        </div>

        <div>
          <label htmlFor="phone" className="block text-sm font-semibold text-slate-700 mb-2">
            Telefon *
          </label>
          <input
            type="tel"
            id="phone"
            name="phone"
            value={formData.phone}
            onChange={handleChange}
            className={`w-full px-4 py-3 rounded-lg border ${
              errors.phone ? 'border-red-500' : 'border-slate-300'
            } focus:outline-none focus:ring-2 focus:ring-blue-500`}
            placeholder="+48 123 456 789"
          />
          {errors.phone && <p className="mt-1 text-sm text-red-600">{errors.phone}</p>}
        </div>

        <div>
          <label htmlFor="loanAmount" className="block text-sm font-semibold text-slate-700 mb-2">
            Kwota kredytu (opcjonalnie)
          </label>
          <input
            type="text"
            id="loanAmount"
            name="loanAmount"
            value={formData.loanAmount}
            onChange={handleChange}
            className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="np. 500 000 PLN"
          />
        </div>

        <div>
          <label htmlFor="bankName" className="block text-sm font-semibold text-slate-700 mb-2">
            Bank (opcjonalnie)
          </label>
          <select
            id="bankName"
            name="bankName"
            value={formData.bankName}
            onChange={handleChange}
            className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Wybierz bank</option>
            <option value="PKO BP">PKO Bank Polski</option>
            <option value="mBank">mBank</option>
            <option value="Millennium">Bank Millennium</option>
            <option value="Pekao">Bank Pekao S.A.</option>
            <option value="ING">ING Bank Śląski</option>
            <option value="Santander">Santander Bank Polska</option>
            <option value="Alior">Alior Bank</option>
            <option value="BZ WBK">BZ WBK (Santander)</option>
            <option value="Getin">Getin Noble Bank</option>
            <option value="Inny">Inny</option>
          </select>
        </div>

        <div className="pt-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              name="consent"
              checked={formData.consent}
              onChange={handleChange}
              className="mt-1 w-5 h-5 text-blue-600 border-slate-300 rounded focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm text-slate-700">
              Wyrażam zgodę na przetwarzanie moich danych osobowych w celu kontaktu oraz
              przedstawienia oferty usług prawnych. *
            </span>
          </label>
          {errors.consent && <p className="mt-2 text-sm text-red-600">{errors.consent}</p>}
        </div>

        <button
          type="submit"
          className="w-full bg-gradient-to-r from-blue-600 to-blue-700 text-white font-bold py-4 px-8 rounded-lg hover:from-blue-700 hover:to-blue-800 transition-all shadow-lg hover:shadow-xl text-lg"
        >
          Wyślij zapytanie
        </button>

        <p className="text-xs text-center text-slate-500">
          * Pola wymagane
        </p>
      </div>
    </form>
  );
}
